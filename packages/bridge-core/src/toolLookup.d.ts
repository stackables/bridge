/**
 * Tool function lookup, ToolDef resolution, and tool-dependency execution.
 *
 * Extracted from ExecutionTree.ts — Phase 3 of the refactor.
 * See docs/execution-tree-refactor.md
 *
 * All functions take a `ToolLookupContext` instead of accessing `this`,
 * keeping the dependency surface explicit and testable.
 */
import type { Instruction, ToolCallFn, ToolDef, ToolMap } from "./types.ts";
import type { MaybePromise } from "./tree-types.ts";
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
    callTool(toolName: string, fnName: string, fnImpl: (...args: any[]) => any, input: Record<string, any>): MaybePromise<any>;
}
/**
 * Deep-lookup a tool function by dotted name (e.g. "std.str.toUpperCase").
 * Falls back to a flat key lookup for backward compat (e.g. "hereapi.geocode"
 * as literal key).
 */
export declare function lookupToolFn(ctx: ToolLookupContext, name: string): ToolCallFn | ((...args: any[]) => any) | undefined;
/**
 * Resolve a ToolDef by name, merging the extends chain (cached).
 */
export declare function resolveToolDefByName(ctx: ToolLookupContext, name: string): ToolDef | undefined;
/**
 * Resolve a tool definition's wires into a nested input object.
 */
export declare function resolveToolWires(ctx: ToolLookupContext, toolDef: ToolDef, input: Record<string, any>): Promise<void>;
/**
 * Resolve a source reference from a tool wire against its dependencies.
 */
export declare function resolveToolSource(ctx: ToolLookupContext, source: string, toolDef: ToolDef): Promise<any>;
/**
 * Call a tool dependency (cached per request).
 * Delegates to the root of the parent chain so shadow trees share the cache.
 */
export declare function resolveToolDep(ctx: ToolLookupContext, toolName: string): Promise<any>;
//# sourceMappingURL=toolLookup.d.ts.map