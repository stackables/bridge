/**
 * Tool function lookup, ToolDef resolution, and tool-dependency execution.
 *
 * Extracted from ExecutionTree.ts — Phase 3 of the refactor.
 * See docs/execution-tree-refactor.md
 *
 * All functions take a `ToolLookupContext` instead of accessing `this`,
 * keeping the dependency surface explicit and testable.
 */

import type {
  Instruction,
  NodeRef,
  ToolCallFn,
  ToolDef,
  ToolMap,
  Wire,
} from "./types.ts";
import { SELF_MODULE } from "./types.ts";
import type { MaybePromise } from "./tree-types.ts";
import {
  trunkKey,
  setNested,
  coerceConstant,
  UNSAFE_KEYS,
} from "./tree-utils.ts";

// ── Context interface ───────────────────────────────────────────────────────

/**
 * Narrow context interface for tool lookup operations.
 *
 * `ExecutionTree` implements this alongside `TreeContext`.  Extracted
 * functions depend only on this contract, keeping them testable without
 * the full engine.
 */
export interface ToolLookupContext {
  readonly toolFns?: ToolMap | undefined;
  readonly toolDefCache: Map<string, ToolDef | null>;
  readonly toolDepCache: Map<string, Promise<any>>;
  readonly instructions: readonly Instruction[];
  readonly context?: Record<string, any> | undefined;
  readonly parent?: ToolLookupContext | undefined;
  readonly state: Record<string, any>;
  callTool(
    toolName: string,
    fnName: string,
    fnImpl: (...args: any[]) => any,
    input: Record<string, any>,
    memoizeKey?: string,
  ): MaybePromise<any>;
}

// ── Tool function lookup ────────────────────────────────────────────────────

/**
 * Deep-lookup a tool function by dotted name (e.g. "std.str.toUpperCase").
 * Falls back to a flat key lookup for backward compat (e.g. "hereapi.geocode"
 * as literal key).
 */
export function lookupToolFn(
  ctx: ToolLookupContext,
  name: string,
): ToolCallFn | ((...args: any[]) => any) | undefined {
  const toolFns = ctx.toolFns;
  if (name.includes(".")) {
    // Check flat key first — explicit overrides (e.g. "std.httpCall" as a
    // literal property) take precedence over namespace traversal so that
    // users can override built-in tools without replacing the whole namespace.
    const flat = (toolFns as any)?.[name];
    if (typeof flat === "function") return flat;

    // Namespace traversal (e.g. toolFns.std.httpCall)
    const parts = name.split(".");
    let current: any = toolFns;
    for (const part of parts) {
      if (UNSAFE_KEYS.has(part)) return undefined;
      if (current == null || typeof current !== "object") {
        current = undefined;
        break;
      }
      current = current[part];
    }
    if (typeof current === "function") return current;

    // Try versioned namespace keys (e.g. "std.str@999.1" → { toLowerCase })
    // For "std.str.toLowerCase@999.1", check:
    //   toolFns["std.str@999.1"]?.toLowerCase
    //   toolFns["std@999.1"]?.str?.toLowerCase
    const atIdx = name.lastIndexOf("@");
    if (atIdx > 0) {
      const baseName = name.substring(0, atIdx);
      const version = name.substring(atIdx + 1);
      const nameParts = baseName.split(".");
      for (let i = nameParts.length - 1; i >= 1; i--) {
        const nsKey = nameParts.slice(0, i).join(".") + "@" + version;
        const remainder = nameParts.slice(i);
        let ns: any = (toolFns as any)?.[nsKey];
        if (ns != null && typeof ns === "object") {
          for (const part of remainder) {
            if (ns == null || typeof ns !== "object") {
              ns = undefined;
              break;
            }
            ns = ns[part];
          }
          if (typeof ns === "function") return ns;
        }
      }
    }

    return undefined;
  }
  // Try root level first
  const fn = (toolFns as any)?.[name];
  if (typeof fn === "function") return fn;
  // Fall back to std namespace (builtins are callable without std. prefix)
  const stdFn = (toolFns as any)?.std?.[name];
  if (typeof stdFn === "function") return stdFn;
  // Fall back to internal namespace (engine-internal tools: math ops, concat, etc.)
  const internalFn = (toolFns as any)?.internal?.[name];
  return typeof internalFn === "function" ? internalFn : undefined;
}

// ── ToolDef resolution ──────────────────────────────────────────────────────

/**
 * Resolve a ToolDef by name, merging the extends chain (cached).
 */
export function resolveToolDefByName(
  ctx: ToolLookupContext,
  name: string,
): ToolDef | undefined {
  if (ctx.toolDefCache.has(name))
    return ctx.toolDefCache.get(name) ?? undefined;

  const toolDefs = ctx.instructions.filter(
    (i): i is ToolDef => i.kind === "tool",
  );
  const base = toolDefs.find((t) => t.name === name);
  if (!base) {
    ctx.toolDefCache.set(name, null);
    return undefined;
  }

  // Build extends chain: root → ... → leaf
  const chain: ToolDef[] = [base];
  let current = base;
  while (current.extends) {
    const parent = toolDefs.find((t) => t.name === current.extends);
    if (!parent)
      throw new Error(
        `Tool "${current.name}" extends unknown tool "${current.extends}"`,
      );
    chain.unshift(parent);
    current = parent;
  }

  // Merge: root provides base, each child overrides
  const merged: ToolDef = {
    kind: "tool",
    name,
    fn: chain[0].fn, // fn from root ancestor
    handles: [],
    wires: [],
  };

  for (const def of chain) {
    // Merge handles (dedupe by handle name)
    for (const h of def.handles) {
      if (!merged.handles.some((mh) => mh.handle === h.handle)) {
        merged.handles.push(h);
      }
    }
    // Merge wires (child overrides parent by target path)
    for (const wire of def.wires) {
      const wireTargetKey = "to" in wire ? wire.to.path.join(".") : undefined;
      if (wireTargetKey != null) {
        const idx = merged.wires.findIndex(
          (w) => "to" in w && w.to.path.join(".") === wireTargetKey,
        );
        if (idx >= 0) merged.wires[idx] = wire;
        else merged.wires.push(wire);
      } else {
        merged.wires.push(wire);
      }
    }
    // Last onError wins
    if (def.onError) merged.onError = def.onError;
    // Merge pipeHandles (dedupe by key, child overrides parent)
    if (def.pipeHandles) {
      if (!merged.pipeHandles) merged.pipeHandles = [];
      for (const ph of def.pipeHandles) {
        const idx = merged.pipeHandles.findIndex((m) => m.key === ph.key);
        if (idx >= 0) merged.pipeHandles[idx] = ph;
        else merged.pipeHandles.push(ph);
      }
    }
  }

  ctx.toolDefCache.set(name, merged);
  return merged;
}

// ── Tool wire resolution ────────────────────────────────────────────────────

/**
 * Resolve a tool definition's wires into a nested input object.
 * Wires use the unified Wire type with sources[] and catch.
 */
export async function resolveToolWires(
  ctx: ToolLookupContext,
  toolDef: ToolDef,
  input: Record<string, any>,
): Promise<void> {
  const forkKeys = new Set<string>();
  if (toolDef.pipeHandles) {
    for (const ph of toolDef.pipeHandles) forkKeys.add(ph.key);
  }

  const isForkTarget = (w: Wire): boolean => {
    const key = trunkKey(w.to);
    return forkKeys.has(key);
  };

  const mainConstantWires: Wire[] = [];
  const mainPullWires: Wire[] = [];
  const mainTernaryWires: Wire[] = [];
  const mainComplexWires: Wire[] = [];
  const forkWireMap = new Map<string, { constants: Wire[]; pulls: Wire[] }>();

  for (const wire of toolDef.wires) {
    const primary = wire.sources[0]?.expr;
    if (!primary) continue;

    if (isForkTarget(wire)) {
      const key = trunkKey(wire.to);
      let group = forkWireMap.get(key);
      if (!group) {
        group = { constants: [], pulls: [] };
        forkWireMap.set(key, group);
      }
      if (primary.type === "literal" && wire.sources.length === 1) {
        group.constants.push(wire);
      } else if (primary.type === "ref") {
        group.pulls.push(wire);
      }
    } else if (wire.sources.length > 1 || wire.catch) {
      mainComplexWires.push(wire);
    } else if (primary.type === "ternary") {
      mainTernaryWires.push(wire);
    } else if (primary.type === "literal") {
      mainConstantWires.push(wire);
    } else if (primary.type === "ref") {
      mainPullWires.push(wire);
    }
  }

  // Execute pipe forks in instance order
  const forkResults = new Map<string, any>();
  if (forkWireMap.size > 0) {
    const sortedForkKeys = [...forkWireMap.keys()].sort((a, b) => {
      const instA = parseInt(a.split(":").pop() ?? "0", 10);
      const instB = parseInt(b.split(":").pop() ?? "0", 10);
      return instA - instB;
    });

    for (const forkKey of sortedForkKeys) {
      const group = forkWireMap.get(forkKey)!;
      const forkInput: Record<string, any> = {};

      for (const wire of group.constants) {
        const expr = wire.sources[0]!.expr;
        if (expr.type === "literal") {
          setNested(forkInput, wire.to.path, coerceConstant(expr.value));
        }
      }

      for (const wire of group.pulls) {
        const expr = wire.sources[0]!.expr;
        if (expr.type !== "ref") continue;
        const value = await resolveToolExprRef(
          ctx,
          expr.ref,
          toolDef,
          forkResults,
        );
        setNested(forkInput, wire.to.path, value);
      }

      const forkToolName = forkKey.split(":")[2] ?? "";
      const fn = lookupToolFn(ctx, forkToolName);
      if (fn) forkResults.set(forkKey, await fn(forkInput));
    }
  }

  // Constants applied synchronously
  for (const wire of mainConstantWires) {
    const expr = wire.sources[0]!.expr;
    if (expr.type === "literal") {
      setNested(input, wire.to.path, coerceConstant(expr.value));
    }
  }

  // Pull wires resolved in parallel
  if (mainPullWires.length > 0) {
    const resolved = await Promise.all(
      mainPullWires.map(async (wire) => {
        const expr = wire.sources[0]!.expr;
        if (expr.type !== "ref") return null;
        const value = await resolveToolExprRef(
          ctx,
          expr.ref,
          toolDef,
          forkResults,
        );
        return { path: wire.to.path, value };
      }),
    );
    for (const entry of resolved) {
      if (entry) setNested(input, entry.path, entry.value);
    }
  }

  // Ternary wires
  for (const wire of mainTernaryWires) {
    const expr = wire.sources[0]!.expr;
    if (expr.type !== "ternary") continue;
    const condRef = expr.cond.type === "ref" ? expr.cond.ref : undefined;
    if (!condRef) continue;
    const condValue = await resolveToolExprRef(
      ctx,
      condRef,
      toolDef,
      forkResults,
    );
    const branchExpr = condValue ? expr.then : expr.else;
    let value: any;
    if (branchExpr.type === "ref") {
      value = await resolveToolExprRef(
        ctx,
        branchExpr.ref,
        toolDef,
        forkResults,
      );
    } else if (branchExpr.type === "literal") {
      value = coerceConstant(branchExpr.value);
    }
    if (value !== undefined) setNested(input, wire.to.path, value);
  }

  // Complex wires (with fallbacks and/or catch)
  for (const wire of mainComplexWires) {
    if (isForkTarget(wire)) continue;
    const primary = wire.sources[0]!.expr;
    let value: any;
    if (primary.type === "ref") {
      try {
        value = await resolveToolExprRef(
          ctx,
          primary.ref,
          toolDef,
          forkResults,
        );
      } catch {
        value = undefined;
      }
    } else if (primary.type === "literal") {
      value = coerceConstant(primary.value);
    }

    // Apply fallback gates
    for (let j = 1; j < wire.sources.length; j++) {
      const fb = wire.sources[j]!;
      const shouldFallback = fb.gate === "nullish" ? value == null : !value;
      if (shouldFallback) {
        if (fb.expr.type === "literal") {
          value = coerceConstant(fb.expr.value);
        } else if (fb.expr.type === "ref") {
          value = await resolveToolExprRef(
            ctx,
            fb.expr.ref,
            toolDef,
            forkResults,
          );
        }
      }
    }

    // Apply catch
    if (wire.catch && value == null) {
      if ("value" in wire.catch) {
        value = coerceConstant(wire.catch.value);
      } else if ("ref" in wire.catch) {
        value = await resolveToolNodeRef(ctx, wire.catch.ref, toolDef);
      }
    }

    setNested(input, wire.to.path, value);
  }
}

/** Resolve a NodeRef, checking fork results first. */
async function resolveToolExprRef(
  ctx: ToolLookupContext,
  ref: NodeRef,
  toolDef: ToolDef,
  forkResults: Map<string, any>,
): Promise<any> {
  const fromKey = trunkKey(ref);
  if (forkResults.has(fromKey)) {
    let value = forkResults.get(fromKey);
    for (const seg of ref.path) value = value?.[seg];
    return value;
  }
  return resolveToolNodeRef(ctx, ref, toolDef);
}

// ── Tool NodeRef resolution ─────────────────────────────────────────────────

/**
 * Resolve a NodeRef from a tool wire against the tool's handles.
 */
export async function resolveToolNodeRef(
  ctx: ToolLookupContext,
  ref: NodeRef,
  toolDef: ToolDef,
): Promise<any> {
  // Find the matching handle by looking at how the ref was built
  // The ref's module/type/field encode which handle it came from
  const handle = toolDef.handles.find((h) => {
    if (h.kind === "context") {
      return (
        ref.module === SELF_MODULE &&
        ref.type === "Context" &&
        ref.field === "context"
      );
    }
    if (h.kind === "const") {
      return (
        ref.module === SELF_MODULE &&
        ref.type === "Const" &&
        ref.field === "const"
      );
    }
    if (h.kind === "tool") {
      // Tool handle: module is the namespace part, field is the tool name part
      const lastDot = h.name.lastIndexOf(".");
      if (lastDot !== -1) {
        return (
          ref.module === h.name.substring(0, lastDot) &&
          ref.field === h.name.substring(lastDot + 1)
        );
      }
      return (
        ref.module === SELF_MODULE &&
        ref.type === "Tools" &&
        ref.field === h.name
      );
    }
    return false;
  });

  if (!handle) {
    throw new Error(
      `Cannot resolve source in tool "${toolDef.name}": no handle matches ref ${ref.module}:${ref.type}:${ref.field}`,
    );
  }

  let value: any;
  if (handle.kind === "context") {
    // Walk the full parent chain for context
    let cursor: ToolLookupContext | undefined = ctx;
    while (cursor && value === undefined) {
      value = cursor.context;
      cursor = cursor.parent;
    }
  } else if (handle.kind === "const") {
    // Walk the full parent chain for const state
    const constKey = trunkKey({
      module: SELF_MODULE,
      type: "Const",
      field: "const",
    });
    let cursor: ToolLookupContext | undefined = ctx;
    while (cursor && value === undefined) {
      value = cursor.state[constKey];
      cursor = cursor.parent;
    }
  } else if (handle.kind === "tool") {
    value = await resolveToolDep(ctx, handle.name);
  }

  for (const segment of ref.path) {
    value = value[segment];
  }
  return value;
}

// ── Tool source resolution (string-based, for onError) ──────────────────────

/**
 * Resolve a dotted source string against the tool's handles.
 * Used for onError source references which remain string-based.
 */
export async function resolveToolSource(
  ctx: ToolLookupContext,
  source: string,
  toolDef: ToolDef,
): Promise<any> {
  const dotIdx = source.indexOf(".");
  const handleName = dotIdx === -1 ? source : source.substring(0, dotIdx);
  const restPath = dotIdx === -1 ? [] : source.substring(dotIdx + 1).split(".");

  const handle = toolDef.handles.find((h) => h.handle === handleName);
  if (!handle)
    throw new Error(`Unknown source "${handleName}" in tool "${toolDef.name}"`);

  let value: any;
  if (handle.kind === "context") {
    let cursor: ToolLookupContext | undefined = ctx;
    while (cursor && value === undefined) {
      value = cursor.context;
      cursor = cursor.parent;
    }
  } else if (handle.kind === "const") {
    const constKey = trunkKey({
      module: SELF_MODULE,
      type: "Const",
      field: "const",
    });
    let cursor: ToolLookupContext | undefined = ctx;
    while (cursor && value === undefined) {
      value = cursor.state[constKey];
      cursor = cursor.parent;
    }
  } else if (handle.kind === "tool") {
    value = await resolveToolDep(ctx, handle.name);
  }

  for (const segment of restPath) {
    if (value == null) return undefined;
    value = value[segment];
  }
  return value;
}

// ── Constant wire merging ───────────────────────────────────────────────────

/**
 * Merge constant self-wires from a ToolDef into the tool's return value,
 * so that dependents can read constant fields (e.g. `.token = "x"`) as
 * if the tool produced them.  Tool-returned fields take precedence.
 */
export function mergeToolDefConstants(toolDef: ToolDef, result: any): any {
  if (result == null || typeof result !== "object" || Array.isArray(result))
    return result;

  // Build fork keys to skip fork-targeted constants
  const forkKeys = new Set<string>();
  if (toolDef.pipeHandles) {
    for (const ph of toolDef.pipeHandles) {
      forkKeys.add(ph.key);
    }
  }

  for (const wire of toolDef.wires) {
    // Only simple constant wires: single literal source, no catch
    const primary = wire.sources[0]?.expr;
    if (
      !primary ||
      primary.type !== "literal" ||
      wire.sources.length > 1 ||
      wire.catch
    )
      continue;
    if (forkKeys.size > 0 && forkKeys.has(trunkKey(wire.to))) continue;

    const path = wire.to.path;
    if (path.length === 0) continue;

    // Only fill in fields the tool didn't already produce
    if (!(path[0] in result)) {
      setNested(result, path, coerceConstant(primary.value));
    }
  }

  return result;
}

// ── Tool dependency execution ───────────────────────────────────────────────

/**
 * Call a tool dependency (cached per request).
 * Delegates to the root of the parent chain so shadow trees share the cache.
 */
export function resolveToolDep(
  ctx: ToolLookupContext,
  toolName: string,
): Promise<any> {
  // Check parent first (shadow trees delegate)
  if (ctx.parent) return resolveToolDep(ctx.parent, toolName);

  if (ctx.toolDepCache.has(toolName)) return ctx.toolDepCache.get(toolName)!;

  const promise = (async () => {
    const toolDef = resolveToolDefByName(ctx, toolName);
    if (!toolDef) throw new Error(`Tool dependency "${toolName}" not found`);

    const input: Record<string, any> = {};
    await resolveToolWires(ctx, toolDef, input);

    const fn = lookupToolFn(ctx, toolDef.fn!);
    if (!fn) throw new Error(`Tool function "${toolDef.fn}" not registered`);

    // on error: wrap the tool call with fallback
    try {
      const raw = await ctx.callTool(toolName, toolDef.fn!, fn, input);
      return mergeToolDefConstants(toolDef, raw);
    } catch (err) {
      if (!toolDef.onError) throw err;
      if ("value" in toolDef.onError) return JSON.parse(toolDef.onError.value);
      return resolveToolSource(ctx, toolDef.onError.source, toolDef);
    }
  })();

  ctx.toolDepCache.set(toolName, promise);
  return promise;
}
