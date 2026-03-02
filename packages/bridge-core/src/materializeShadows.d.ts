/**
 * Shadow-tree materializer — converts shadow trees into plain JS objects.
 *
 * Extracted from ExecutionTree.ts — Phase 4 of the refactor.
 * See docs/execution-tree-refactor.md
 *
 * The functions operate on a narrow `MaterializerHost` interface (for bridge
 * metadata) and concrete `ExecutionTree` instances (for shadow resolution).
 */
import type { Wire } from "./types.ts";
import type { MaybePromise, Trunk } from "./tree-types.ts";
/**
 * Narrow read-only view into the bridge metadata needed by the materializer.
 *
 * `ExecutionTree` satisfies this via its existing public fields.
 */
export interface MaterializerHost {
    readonly bridge: {
        readonly wires: readonly Wire[];
    } | undefined;
    readonly trunk: Trunk;
}
/**
 * Minimal interface for shadow trees consumed by the materializer.
 *
 * `ExecutionTree` satisfies this via its existing public methods.
 */
export interface MaterializableShadow {
    pullOutputField(path: string[], array?: boolean): Promise<unknown>;
    resolvePreGrouped(wires: Wire[]): MaybePromise<unknown>;
}
/**
 * Scan bridge wires to classify output fields at a given path prefix.
 *
 * Returns a "plan" describing:
 *   - `directFields` — leaf fields with wires at exactly `[...prefix, name]`
 *   - `deepPaths`    — fields with wires deeper than prefix+1 (nested arrays/objects)
 *   - `wireGroupsByPath` — wires pre-grouped by their full path key (#8)
 *
 * The plan is pure data (no side-effects) and is consumed by
 * `materializeShadows` to drive the execution phase.
 */
export declare function planShadowOutput(host: MaterializerHost, pathPrefix: string[]): {
    directFields: Set<string>;
    deepPaths: Map<string, string[][]>;
    wireGroupsByPath: Map<string, Wire[]>;
};
/**
 * Recursively convert shadow trees into plain JS objects.
 *
 * Wire categories at each level (prefix = P):
 *   Leaf  — `to.path = [...P, name]`, no deeper paths → scalar
 *   Array — direct wire AND deeper paths → pull as array, recurse
 *   Nested object — only deeper paths, no direct wire → pull each
 *             full path and assemble via setNested
 */
export declare function materializeShadows(host: MaterializerHost, items: MaterializableShadow[], pathPrefix: string[]): Promise<unknown[]>;
//# sourceMappingURL=materializeShadows.d.ts.map