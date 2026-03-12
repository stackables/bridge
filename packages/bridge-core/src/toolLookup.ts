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
 * Wires use the unified Wire type — constant wires set fixed values,
 * pull wires resolve sources from handles (context, const, tool deps).
 */
export async function resolveToolWires(
  ctx: ToolLookupContext,
  toolDef: ToolDef,
  input: Record<string, any>,
): Promise<void> {
  // Build pipe-fork lookup: key → pipeHandle entry
  const forkKeys = new Set<string>();
  if (toolDef.pipeHandles) {
    for (const ph of toolDef.pipeHandles) {
      forkKeys.add(ph.key);
    }
  }

  // Determine whether a wire targets a pipe fork or the main tool
  const isForkTarget = (w: Wire): boolean => {
    if (!("to" in w)) return false;
    const key = trunkKey(w.to);
    return forkKeys.has(key);
  };

  // Separate wires: main tool wires vs fork wires
  const mainConstantWires: Wire[] = [];
  const mainPullWires: Wire[] = [];
  const mainTernaryWires: Wire[] = [];
  // Fork wires grouped by trunk key, sorted by instance for chain ordering
  const forkWireMap = new Map<string, { constants: Wire[]; pulls: Wire[] }>();

  for (const wire of toolDef.wires) {
    if (isForkTarget(wire)) {
      const key = trunkKey(wire.to);
      let group = forkWireMap.get(key);
      if (!group) {
        group = { constants: [], pulls: [] };
        forkWireMap.set(key, group);
      }
      if ("value" in wire && !("cond" in wire)) {
        group.constants.push(wire);
      } else if ("from" in wire) {
        group.pulls.push(wire);
      }
    } else if ("cond" in wire) {
      mainTernaryWires.push(wire);
    } else if ("value" in wire) {
      mainConstantWires.push(wire);
    } else if ("from" in wire) {
      // Pull wires with fallbacks/catch are processed separately below
      if ("fallbacks" in wire || "catchFallback" in wire) {
        // handled by fallback loop
      } else {
        mainPullWires.push(wire);
      }
    }
  }

  // Execute pipe forks in instance order (lower instance first, chains depend on prior results)
  const forkResults = new Map<string, any>();
  if (forkWireMap.size > 0) {
    // Sort fork keys by instance number to respect chain ordering
    const sortedForkKeys = [...forkWireMap.keys()].sort((a, b) => {
      const instA = parseInt(a.split(":").pop() ?? "0", 10);
      const instB = parseInt(b.split(":").pop() ?? "0", 10);
      return instA - instB;
    });

    for (const forkKey of sortedForkKeys) {
      const group = forkWireMap.get(forkKey)!;
      const forkInput: Record<string, any> = {};

      // Apply constants
      for (const wire of group.constants) {
        if ("value" in wire && "to" in wire) {
          setNested(forkInput, wire.to.path, coerceConstant(wire.value));
        }
      }

      // Resolve pull wires (sources may be handles or prior fork results)
      for (const wire of group.pulls) {
        if (!("from" in wire)) continue;
        const fromKey = trunkKey(wire.from);
        let value: any;
        if (forkResults.has(fromKey)) {
          // Source is a prior fork's result
          value = forkResults.get(fromKey);
          for (const seg of wire.from.path) {
            value = value?.[seg];
          }
        } else {
          value = await resolveToolNodeRef(ctx, wire.from, toolDef);
        }
        setNested(forkInput, wire.to.path, value);
      }

      // Look up and execute the fork tool function
      const forkToolName = forkKey.split(":")[2] ?? "";
      const fn = lookupToolFn(ctx, forkToolName);
      if (fn) {
        forkResults.set(forkKey, await fn(forkInput));
      }
    }
  }

  // Constants applied synchronously
  for (const wire of mainConstantWires) {
    if ("value" in wire && "to" in wire) {
      setNested(input, wire.to.path, coerceConstant(wire.value));
    }
  }

  // Pull wires resolved in parallel (independent deps shouldn't wait on each other)
  if (mainPullWires.length > 0) {
    const resolved = await Promise.all(
      mainPullWires.map(async (wire) => {
        if (!("from" in wire)) return null;
        const fromKey = trunkKey(wire.from);
        let value: any;
        if (forkResults.has(fromKey)) {
          // Source is a fork result (e.g., expression chain output)
          value = forkResults.get(fromKey);
          for (const seg of wire.from.path) {
            value = value?.[seg];
          }
        } else {
          value = await resolveToolNodeRef(ctx, wire.from, toolDef);
        }
        return { path: wire.to.path, value };
      }),
    );
    for (const entry of resolved) {
      if (entry) setNested(input, entry.path, entry.value);
    }
  }

  // Ternary wires: evaluate condition and pick branch
  for (const wire of mainTernaryWires) {
    if (!("cond" in wire)) continue;
    const condValue = await resolveToolNodeRef(ctx, wire.cond, toolDef);
    let value: any;
    if (condValue) {
      if ("thenRef" in wire && wire.thenRef) {
        const fromKey = trunkKey(wire.thenRef);
        if (forkResults.has(fromKey)) {
          value = forkResults.get(fromKey);
          for (const seg of wire.thenRef.path) value = value?.[seg];
        } else {
          value = await resolveToolNodeRef(ctx, wire.thenRef, toolDef);
        }
      } else if ("thenValue" in wire && wire.thenValue !== undefined) {
        value = coerceConstant(wire.thenValue);
      }
    } else {
      if ("elseRef" in wire && wire.elseRef) {
        const fromKey = trunkKey(wire.elseRef);
        if (forkResults.has(fromKey)) {
          value = forkResults.get(fromKey);
          for (const seg of wire.elseRef.path) value = value?.[seg];
        } else {
          value = await resolveToolNodeRef(ctx, wire.elseRef, toolDef);
        }
      } else if ("elseValue" in wire && wire.elseValue !== undefined) {
        value = coerceConstant(wire.elseValue);
      }
    }
    if (value !== undefined) setNested(input, wire.to.path, value);
  }

  // Handle fallback wires (coalesce/catch) on main pull wires
  for (const wire of toolDef.wires) {
    if (isForkTarget(wire)) continue;
    if (!("from" in wire) || !("fallbacks" in wire)) continue;
    // The value was already set by the pull wire resolution above.
    // Check if it needs fallback processing.
    const fromKey = trunkKey(wire.from);
    let value: any;
    if (forkResults.has(fromKey)) {
      value = forkResults.get(fromKey);
      for (const seg of wire.from.path) value = value?.[seg];
    } else {
      try {
        value = await resolveToolNodeRef(ctx, wire.from, toolDef);
      } catch {
        value = undefined;
      }
    }

    // Apply fallback chain
    if (wire.fallbacks) {
      for (const fb of wire.fallbacks) {
        const shouldFallback = fb.type === "nullish" ? value == null : !value;
        if (shouldFallback) {
          if (fb.value !== undefined) {
            value = coerceConstant(fb.value);
          } else if (fb.ref) {
            const fbKey = trunkKey(fb.ref);
            if (forkResults.has(fbKey)) {
              value = forkResults.get(fbKey);
              for (const seg of fb.ref.path) value = value?.[seg];
            } else {
              value = await resolveToolNodeRef(ctx, fb.ref, toolDef);
            }
          }
        }
      }
    }

    // Apply catch fallback
    if ("catchFallback" in wire && wire.catchFallback !== undefined) {
      if (value == null) {
        value = coerceConstant(wire.catchFallback);
      }
    }

    setNested(input, wire.to.path, value);
  }
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
      return await ctx.callTool(toolName, toolDef.fn!, fn, input);
    } catch (err) {
      if (!toolDef.onError) throw err;
      if ("value" in toolDef.onError) return JSON.parse(toolDef.onError.value);
      return resolveToolSource(ctx, toolDef.onError.source, toolDef);
    }
  })();

  ctx.toolDepCache.set(toolName, promise);
  return promise;
}
