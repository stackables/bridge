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
import type { MaybePromise, Trunk } from "./tree-types.ts";
import { type ToolLookupContext } from "./toolLookup.ts";
/**
 * Narrow context interface for the scheduling subsystem.
 *
 * `ExecutionTree` satisfies this via its existing public fields and methods.
 * The interface is intentionally wide because scheduling is the central
 * dispatch logic that ties wire resolution, tool lookup, and instrumentation
 * together — but it is still a strict subset of the full class.
 */
export interface SchedulerContext extends ToolLookupContext {
    readonly bridge: Bridge | undefined;
    /** Parent tree for shadow-tree delegation.  `schedule()` recurses via parent. */
    readonly parent?: SchedulerContext | undefined;
    /** Pipe fork lookup map — maps fork trunk keys to their base trunk. */
    readonly pipeHandleMap: ReadonlyMap<string, {
        readonly baseTrunk: Trunk;
    }> | undefined;
    /** Handle version tags (`@version`) for versioned tool lookups. */
    readonly handleVersionMap: ReadonlyMap<string, string>;
    /** Recursive entry point — parent delegation calls this. */
    schedule(target: Trunk, pullChain?: Set<string>): MaybePromise<any>;
    /** Resolve a set of matched wires (delegates to resolveWires.ts). */
    resolveWires(wires: Wire[], pullChain?: Set<string>): MaybePromise<any>;
}
/**
 * Schedule resolution for a target trunk.
 *
 * This is the central dispatch method:
 *   1. Shadow-tree parent delegation (element-scoped wires stay local)
 *   2. Collect and group bridge wires (base + fork)
 *   3. Route to `scheduleToolDef` (async, ToolDef-backed) or
 *      inline sync resolution + `scheduleFinish` (direct tools / passthrough)
 */
export declare function schedule(ctx: SchedulerContext, target: Trunk, pullChain?: Set<string>): MaybePromise<any>;
/**
 * Assemble input from resolved wire values and either invoke a direct tool
 * function or return the data for pass-through targets (local/define/logic).
 * Returns synchronously when the tool function (if any) returns sync.
 * See docs/performance.md (#12).
 */
export declare function scheduleFinish(ctx: SchedulerContext, target: Trunk, toolName: string, groupEntries: [string, Wire[]][], resolvedValues: any[], baseTrunk: Trunk | undefined): MaybePromise<any>;
/**
 * Full async schedule path for targets backed by a ToolDef.
 * Resolves tool wires, bridge wires, and invokes the tool function
 * with error recovery support.
 */
export declare function scheduleToolDef(ctx: SchedulerContext, toolName: string, toolDef: ToolDef, wireGroups: Map<string, Wire[]>, pullChain: Set<string> | undefined): Promise<any>;
//# sourceMappingURL=scheduleTools.d.ts.map