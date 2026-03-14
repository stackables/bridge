/**
 * Tool scheduling — wire grouping, input assembly, and tool dispatch.
 *
 * Extracted from ExecutionTree.ts — Phase 5 of the refactor.
 * See docs/execution-tree-refactor.md
 *
 * The functions operate on a narrow `SchedulerContext` interface,
 * keeping the dependency surface explicit.
 */

import type { Bridge, Expression, NodeRef, ToolDef, Wire } from "./types.ts";
import { SELF_MODULE } from "./types.ts";
import { isPromise, wrapBridgeRuntimeError } from "./tree-types.ts";
import type { MaybePromise, Trunk } from "./tree-types.ts";
import { trunkKey, sameTrunk, setNested } from "./tree-utils.ts";
import {
  lookupToolFn,
  resolveToolDefByName,
  resolveToolWires,
  resolveToolSource,
  mergeToolDefConstants,
  type ToolLookupContext,
} from "./toolLookup.ts";

// ── Context interface ───────────────────────────────────────────────────────

/**
 * Narrow context interface for the scheduling subsystem.
 *
 * `ExecutionTree` satisfies this via its existing public fields and methods.
 * The interface is intentionally wide because scheduling is the central
 * dispatch logic that ties wire resolution, tool lookup, and instrumentation
 * together — but it is still a strict subset of the full class.
 */
export interface SchedulerContext extends ToolLookupContext {
  // ── Scheduler-specific fields ──────────────────────────────────────────
  readonly bridge: Bridge | undefined;
  /** Parent tree for shadow-tree delegation.  `schedule()` recurses via parent. */
  readonly parent?: SchedulerContext | undefined;
  /** Pipe fork lookup map — maps fork trunk keys to their base trunk. */
  readonly pipeHandleMap:
    | ReadonlyMap<string, { readonly baseTrunk: Trunk }>
    | undefined;
  /** Handle version tags (`@version`) for versioned tool lookups. */
  readonly handleVersionMap: ReadonlyMap<string, string>;
  /** Tool trunks marked with `memoize`. */
  readonly memoizedToolKeys: ReadonlySet<string>;

  // ── Methods ────────────────────────────────────────────────────────────
  /** Recursive entry point — parent delegation calls this. */
  schedule(target: Trunk, pullChain?: Set<string>): MaybePromise<any>;
  /** Resolve a set of matched wires (delegates to resolveWires.ts). */
  resolveWires(wires: Wire[], pullChain?: Set<string>): MaybePromise<any>;
}

function getBridgeLocFromGroups(groupEntries: [string, Wire[]][]): Wire["loc"] {
  for (const [, wires] of groupEntries) {
    for (const wire of wires) {
      if (wire.loc) return wire.loc;
    }
  }
  return undefined;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Derive tool name from a trunk. */
function getToolName(target: Trunk): string {
  if (target.module === SELF_MODULE) return target.field;
  return `${target.module}.${target.field}`;
}

function refsInWire(wire: Wire): NodeRef[] {
  const refs: NodeRef[] = [];
  // Collect refs from all source expressions
  for (const source of wire.sources) {
    collectExprRefs(source.expr, refs);
  }
  // Collect ref from catch handler
  if (wire.catch && "ref" in wire.catch) {
    refs.push(wire.catch.ref);
  }
  return refs;
}

function collectExprRefs(expr: Expression, refs: NodeRef[]): void {
  switch (expr.type) {
    case "ref":
      refs.push(expr.ref);
      break;
    case "ternary":
      collectExprRefs(expr.cond, refs);
      collectExprRefs(expr.then, refs);
      collectExprRefs(expr.else, refs);
      break;
    case "and":
    case "or":
      collectExprRefs(expr.left, refs);
      collectExprRefs(expr.right, refs);
      break;
    // literal, control — no refs
  }
}

export function trunkDependsOnElement(
  bridge: Bridge | undefined,
  target: Trunk,
  visited = new Set<string>(),
): boolean {
  if (!bridge) return false;

  // The current bridge trunk doubles as the input state container. Do not walk
  // its incoming output wires when classifying element scope; refs like
  // `i.category` would otherwise inherit element scope from unrelated output
  // array mappings on the same bridge.
  if (
    target.module === "_" &&
    target.type === bridge.type &&
    target.field === bridge.field
  ) {
    return false;
  }

  const key = trunkKey(target);
  if (visited.has(key)) return false;
  visited.add(key);

  const incoming = bridge.wires.filter((wire) => sameTrunk(wire.to, target));
  for (const wire of incoming) {
    if (wire.to.element) return true;

    for (const ref of refsInWire(wire)) {
      if (ref.element) return true;
      const sourceTrunk: Trunk = {
        module: ref.module,
        type: ref.type,
        field: ref.field,
        instance: ref.instance,
      };
      if (trunkDependsOnElement(bridge, sourceTrunk, visited)) {
        return true;
      }
    }
  }

  return false;
}

// ── Schedule ────────────────────────────────────────────────────────────────

/**
 * Schedule resolution for a target trunk.
 *
 * This is the central dispatch method:
 *   1. Shadow-tree parent delegation (element-scoped wires stay local)
 *   2. Collect and group bridge wires (base + fork)
 *   3. Route to `scheduleToolDef` (async, ToolDef-backed) or
 *      inline sync resolution + `scheduleFinish` (direct tools / passthrough)
 */
export function schedule(
  ctx: SchedulerContext,
  target: Trunk,
  pullChain?: Set<string>,
): MaybePromise<any> {
  // Delegate to parent (shadow trees don't schedule directly) unless
  // the target fork has bridge wires sourced from element data,
  // including transitive sources routed through __local / __define_* trunks.
  if (ctx.parent) {
    if (!trunkDependsOnElement(ctx.bridge, target)) {
      return ctx.parent.schedule(target, pullChain);
    }
  }

  // ── Sync work: collect and group bridge wires ─────────────────
  // If this target is a pipe fork, also apply bridge wires from its base
  // handle (non-pipe wires, e.g. `c.currency <- i.currency`) as defaults
  // before the fork-specific pipe wires.
  const targetKey = trunkKey(target);
  const pipeFork = ctx.pipeHandleMap?.get(targetKey);
  const baseTrunk = pipeFork?.baseTrunk;

  const baseWires = baseTrunk
    ? (ctx.bridge?.wires.filter(
        (w) => !("pipe" in w) && sameTrunk(w.to, baseTrunk),
      ) ?? [])
    : [];
  // Fork-specific wires (pipe wires targeting the fork's own instance)
  const forkWires =
    ctx.bridge?.wires.filter((w) => sameTrunk(w.to, target)) ?? [];
  // Merge: base provides defaults, fork overrides
  const bridgeWires = [...baseWires, ...forkWires];

  // Look up ToolDef for this target
  const toolName = getToolName(target);
  const toolDef = resolveToolDefByName(ctx, toolName);

  // Group wires by target path so that || (null-fallback) and ??
  // (error-fallback) semantics are honoured via resolveWires().
  const wireGroups = new Map<string, Wire[]>();
  for (const w of bridgeWires) {
    const key = w.to.path.join(".");
    let group = wireGroups.get(key);
    if (!group) {
      group = [];
      wireGroups.set(key, group);
    }
    group.push(w);
  }

  // ── Async path: tool definition requires resolveToolWires + callTool ──
  if (toolDef) {
    return scheduleToolDef(
      ctx,
      target,
      toolName,
      toolDef,
      wireGroups,
      pullChain,
    );
  }

  // ── Sync-capable path: no tool definition ──
  // For __local bindings, __define_ pass-throughs, pipe forks backed by
  // sync tools, and logic nodes — resolve bridge wires and return
  // synchronously when all sources are already in state.
  // See packages/bridge-core/performance.md (#12).
  const groupEntries = Array.from(wireGroups.entries());
  const nGroups = groupEntries.length;
  const values: MaybePromise<any>[] = new Array(nGroups);
  let hasAsync = false;
  for (let i = 0; i < nGroups; i++) {
    const v = ctx.resolveWires(groupEntries[i]![1], pullChain);
    values[i] = v;
    if (!hasAsync && isPromise(v)) hasAsync = true;
  }

  if (!hasAsync) {
    return scheduleFinish(
      ctx,
      target,
      toolName,
      groupEntries,
      values as any[],
      baseTrunk,
    );
  }
  return Promise.all(values).then((resolved) =>
    scheduleFinish(ctx, target, toolName, groupEntries, resolved, baseTrunk),
  );
}

// ── Schedule finish ─────────────────────────────────────────────────────────

/**
 * Assemble input from resolved wire values and either invoke a direct tool
 * function or return the data for pass-through targets (local/define/logic).
 * Returns synchronously when the tool function (if any) returns sync.
 * See packages/bridge-core/performance.md (#12).
 */
export function scheduleFinish(
  ctx: SchedulerContext,
  target: Trunk,
  toolName: string,
  groupEntries: [string, Wire[]][],
  resolvedValues: any[],
  baseTrunk: Trunk | undefined,
): MaybePromise<any> {
  const input: Record<string, any> = {};
  const resolved: [string[], any][] = [];
  const bridgeLoc = getBridgeLocFromGroups(groupEntries);
  for (let i = 0; i < groupEntries.length; i++) {
    const path = groupEntries[i]![1][0]!.to.path;
    const value = resolvedValues[i];
    resolved.push([path, value]);
    if (path.length === 0 && value != null && typeof value === "object") {
      Object.assign(input, value);
    } else {
      setNested(input, path, value);
    }
  }

  // Direct tool function lookup by name (simple or dotted).
  // When the handle carries a @version tag, try the versioned key first
  // (e.g. "std.str.toLowerCase@999.1") so user-injected overrides win.
  // For pipe forks, fall back to the baseTrunk's version since forks
  // use synthetic instance numbers (100000+).
  const handleVersion =
    ctx.handleVersionMap.get(trunkKey(target)) ??
    (baseTrunk ? ctx.handleVersionMap.get(trunkKey(baseTrunk)) : undefined);
  let directFn = handleVersion
    ? lookupToolFn(ctx, `${toolName}@${handleVersion}`)
    : undefined;
  if (!directFn) {
    directFn = lookupToolFn(ctx, toolName);
  }
  if (directFn) {
    const memoizeKey = ctx.memoizedToolKeys.has(trunkKey(target))
      ? trunkKey(target)
      : undefined;
    return ctx.callTool(toolName, toolName, directFn, input, memoizeKey);
  }

  // Define pass-through: synthetic trunks created by define inlining
  // act as data containers — bridge wires set their values, no tool needed.
  if (target.module.startsWith("__define_")) {
    return input;
  }

  // Local binding or logic node: the wire resolves the source and stores
  // the result — no tool call needed.  For path=[] wires the resolved
  // value may be a primitive (boolean from condAnd/condOr, string from
  // a pipe tool like upperCase), so return the resolved value directly.
  if (
    target.module === "__local" ||
    target.field === "__and" ||
    target.field === "__or"
  ) {
    for (const [path, value] of resolved) {
      if (path.length === 0) return value;
    }
    return input;
  }

  throw wrapBridgeRuntimeError(new Error(`No tool found for "${toolName}"`), {
    bridgeLoc,
  });
}

// ── Schedule ToolDef ────────────────────────────────────────────────────────

/**
 * Full async schedule path for targets backed by a ToolDef.
 * Resolves tool wires, bridge wires, and invokes the tool function
 * with error recovery support.
 */
export async function scheduleToolDef(
  ctx: SchedulerContext,
  target: Trunk,
  toolName: string,
  toolDef: ToolDef,
  wireGroups: Map<string, Wire[]>,
  pullChain: Set<string> | undefined,
): Promise<any> {
  // Build input object: tool wires first (base), then bridge wires (override)
  const input: Record<string, any> = {};
  await resolveToolWires(ctx, toolDef, input);

  // Resolve bridge wires and apply on top
  const groupEntries = Array.from(wireGroups.entries());
  const resolved = await Promise.all(
    groupEntries.map(async ([, group]): Promise<[string[], any]> => {
      const value = await ctx.resolveWires(group, pullChain);
      return [group[0].to.path, value];
    }),
  );
  for (const [path, value] of resolved) {
    if (path.length === 0 && value != null && typeof value === "object") {
      Object.assign(input, value);
    } else {
      setNested(input, path, value);
    }
  }

  const bridgeLoc = getBridgeLocFromGroups(groupEntries);

  // Call ToolDef-backed tool function
  const fn = lookupToolFn(ctx, toolDef.fn!);
  if (!fn) {
    throw wrapBridgeRuntimeError(
      new Error(`Tool function "${toolDef.fn}" not registered`),
      {
        bridgeLoc,
      },
    );
  }

  // on error: wrap the tool call with fallback
  try {
    const memoizeKey = ctx.memoizedToolKeys.has(trunkKey(target))
      ? trunkKey(target)
      : undefined;
    const raw = await ctx.callTool(
      toolName,
      toolDef.fn!,
      fn,
      input,
      memoizeKey,
    );
    return mergeToolDefConstants(toolDef, raw);
  } catch (err) {
    if (!toolDef.onError) throw err;
    if ("value" in toolDef.onError) return JSON.parse(toolDef.onError.value);
    return resolveToolSource(ctx, toolDef.onError.source, toolDef);
  }
}
