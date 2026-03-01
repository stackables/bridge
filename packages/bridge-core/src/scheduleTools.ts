/**
 * Tool scheduling — wire grouping, input assembly, and tool dispatch.
 *
 * Extracted from ExecutionTree.ts — Phase 5 of the refactor.
 * See docs/execution-tree-refactor.md
 *
 * The functions operate on a narrow `SchedulerContext` interface,
 * keeping the dependency surface explicit.
 */

import type { Bridge, ToolDef, Wire } from "./types.ts";
import { SELF_MODULE } from "./types.ts";
import { isPromise } from "./tree-types.ts";
import type { MaybePromise, Trunk } from "./tree-types.ts";
import { trunkKey, sameTrunk, setNested } from "./tree-utils.ts";
import {
  lookupToolFn,
  resolveToolDefByName,
  resolveToolWires,
  resolveToolSource,
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

  // ── Methods ────────────────────────────────────────────────────────────
  /** Recursive entry point — parent delegation calls this. */
  schedule(target: Trunk, pullChain?: Set<string>): MaybePromise<any>;
  /** Resolve a set of matched wires (delegates to resolveWires.ts). */
  resolveWires(wires: Wire[], pullChain?: Set<string>): MaybePromise<any>;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Derive tool name from a trunk. */
function getToolName(target: Trunk): string {
  if (target.module === SELF_MODULE) return target.field;
  return `${target.module}.${target.field}`;
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
  // or a __local binding whose source chain touches element data.
  if (ctx.parent) {
    const forkWires =
      ctx.bridge?.wires.filter((w) => sameTrunk(w.to, target)) ?? [];
    const hasElementSource = forkWires.some(
      (w) =>
        ("from" in w && !!w.from.element) ||
        ("condAnd" in w &&
          (!!w.condAnd.leftRef.element || !!w.condAnd.rightRef?.element)) ||
        ("condOr" in w &&
          (!!w.condOr.leftRef.element || !!w.condOr.rightRef?.element)),
    );
    // For __local trunks, also check transitively: if the source is a
    // pipe fork whose own wires reference element data, keep it local.
    const hasTransitiveElementSource =
      target.module === "__local" &&
      forkWires.some((w) => {
        if (!("from" in w)) return false;
        const srcTrunk = {
          module: w.from.module,
          type: w.from.type,
          field: w.from.field,
          instance: w.from.instance,
        };
        return (
          ctx.bridge?.wires.some(
            (iw) =>
              sameTrunk(iw.to, srcTrunk) && "from" in iw && !!iw.from.element,
          ) ?? false
        );
      });
    if (!hasElementSource && !hasTransitiveElementSource) {
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
    return scheduleToolDef(ctx, toolName, toolDef, wireGroups, pullChain);
  }

  // ── Sync-capable path: no tool definition ──
  // For __local bindings, __define_ pass-throughs, pipe forks backed by
  // sync tools, and logic nodes — resolve bridge wires and return
  // synchronously when all sources are already in state.
  // See docs/performance.md (#12).
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
 * See docs/performance.md (#12).
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
    return ctx.callTool(toolName, toolName, directFn, input);
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

  throw new Error(`No tool found for "${toolName}"`);
}

// ── Schedule ToolDef ────────────────────────────────────────────────────────

/**
 * Full async schedule path for targets backed by a ToolDef.
 * Resolves tool wires, bridge wires, and invokes the tool function
 * with error recovery support.
 */
export async function scheduleToolDef(
  ctx: SchedulerContext,
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

  // Call ToolDef-backed tool function
  const fn = lookupToolFn(ctx, toolDef.fn!);
  if (!fn) throw new Error(`Tool function "${toolDef.fn}" not registered`);

  // on error: wrap the tool call with fallback from onError wire
  const onErrorWire = toolDef.wires.find((w) => w.kind === "onError");
  try {
    return await ctx.callTool(toolName, toolDef.fn!, fn, input);
  } catch (err) {
    if (!onErrorWire) throw err;
    if ("value" in onErrorWire) return JSON.parse(onErrorWire.value);
    return resolveToolSource(ctx, onErrorWire.source, toolDef);
  }
}
