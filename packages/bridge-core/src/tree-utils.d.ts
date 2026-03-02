/**
 * Pure utility functions for the execution tree — no class dependency.
 *
 * Extracted from ExecutionTree.ts — Phase 1 of the refactor.
 * See docs/execution-tree-refactor.md
 */
import type { NodeRef, Wire } from "./types.ts";
import type { Trunk } from "./tree-types.ts";
/** Stable string key for the state map */
export declare function trunkKey(ref: Trunk & {
    element?: boolean;
}): string;
/** Match two trunks (ignoring path and element) */
export declare function sameTrunk(a: Trunk, b: Trunk): boolean;
/** Strict path equality — manual loop avoids `.every()` closure allocation.  See docs/performance.md (#7). */
export declare function pathEquals(a: string[], b: string[]): boolean;
export declare function coerceConstant(raw: string): unknown;
export declare const UNSAFE_KEYS: Set<string>;
/** Set a value at a nested path, creating intermediate objects/arrays as needed */
export declare function setNested(obj: any, path: string[], value: any): void;
/** Symbol key for the cached `trunkKey()` result on NodeRef objects. */
export declare const TRUNK_KEY_CACHE: unique symbol;
/** Symbol key for the cached simple-pull ref on Wire objects. */
export declare const SIMPLE_PULL_CACHE: unique symbol;
/**
 * Returns the `from` NodeRef when a wire qualifies for the simple-pull fast
 * path (single `from` wire, no safe/falsy/nullish/catch modifiers).  Returns
 * `null` otherwise.  The result is cached on the wire via a Symbol key so
 * subsequent calls are a single property read without affecting V8 shapes.
 * See docs/performance.md (#11).
 */
export declare function getSimplePullRef(w: Wire): NodeRef | null;
/** Round milliseconds to 2 decimal places */
export declare function roundMs(ms: number): number;
//# sourceMappingURL=tree-utils.d.ts.map