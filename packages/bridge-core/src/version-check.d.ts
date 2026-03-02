import type { BridgeDocument, Instruction, ToolMap } from "./types.ts";
/**
 * Extract the declared bridge version from a document.
 * Returns `undefined` if no version was declared.
 */
export declare function getBridgeVersion(doc: BridgeDocument): string | undefined;
/**
 * Verify that the standard library satisfies the bridge file's declared version.
 *
 * The bridge `version X.Y` header acts as a minimum-version constraint:
 *  - Same major  → compatible (only major bumps introduce breaking changes)
 *  - Bridge minor ≤ std minor → OK (std is same or newer)
 *  - Bridge minor > std minor → ERROR (bridge needs features not in this std)
 *  - Different major → ERROR (user must provide a compatible std explicitly)
 *
 * @throws Error with an actionable message when the std is incompatible.
 */
export declare function checkStdVersion(version: string | undefined, stdVersion: string): void;
/**
 * Resolve the standard library namespace and version to use.
 *
 * Checks the bundled std first.  When the bridge file targets a different
 * major version (e.g. `version 1.5` vs bundled `2.0.0`), scans the
 * user-provided tools map for a versioned namespace key like `"std@1.5"`.
 *
 * @returns The resolved std namespace and its version string.
 * @throws Error with an actionable message when no compatible std is found.
 */
export declare function resolveStd(version: string | undefined, bundledStd: ToolMap, bundledStdVersion: string, userTools?: ToolMap): {
    namespace: ToolMap;
    version: string;
};
/**
 * Collect every tool reference that carries an `@version` tag from handles
 * (bridge/define blocks) and deps (tool blocks).
 */
export declare function collectVersionedHandles(instructions: Instruction[]): Array<{
    name: string;
    version: string;
}>;
/**
 * Check whether a versioned dotted tool name can be resolved.
 *
 * In addition to the standard checks (namespace traversal, flat key),
 * this also checks **versioned namespace keys** in the tool map:
 *   - `"std.str.toLowerCase@999.1"` as a flat key
 *   - `"std.str@999.1"` as a namespace key containing `toLowerCase`
 *   - `"std@999.1"` as a namespace key, traversing to `str.toLowerCase`
 */
export declare function hasVersionedToolFn(toolFns: ToolMap, name: string, version: string): boolean;
/**
 * Validate that all versioned tool handles can be satisfied at runtime.
 *
 * For each handle with `@version`:
 * 1. A versioned key or versioned namespace in the tool map → satisfied
 * 2. A `std.*` tool whose STD_VERSION ≥ the requested version → satisfied
 * 3. Otherwise → throws with an actionable error message
 *
 * Call this **before** constructing the ExecutionTree to fail early.
 *
 * @throws Error when a versioned tool cannot be satisfied.
 */
export declare function checkHandleVersions(instructions: Instruction[], toolFns: ToolMap, stdVersion: string): void;
//# sourceMappingURL=version-check.d.ts.map