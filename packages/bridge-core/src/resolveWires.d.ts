/**
 * Wire resolution — the core data-flow evaluation loop.
 *
 * Extracted from ExecutionTree.ts — Phase 2 of the refactor.
 * See docs/execution-tree-refactor.md
 *
 * All functions take a `TreeContext` as their first argument so they
 * can call back into the tree for `pullSingle` without depending on
 * the full `ExecutionTree` class.
 */
import type { Wire } from "./types.ts";
import type { MaybePromise, TreeContext } from "./tree-types.ts";
/**
 * Resolve a set of matched wires.
 *
 * Architecture: two distinct resolution axes —
 *
 *  **Falsy Gate** (`||`, within a wire): `falsyFallbackRefs` + `falsyFallback`
 *    → truthy check — falsy values (0, "", false) trigger fallback chain.
 *
 *  **Overdefinition** (across wires): multiple wires target the same path
 *    → nullish check — only null/undefined falls through to the next wire.
 *
 * Per-wire layers:
 *   Layer 1  — Execution (pullSingle + safe modifier)
 *   Layer 2a — Falsy Gate   (falsyFallbackRefs → falsyFallback / falsyControl)
 *   Layer 2b — Nullish Gate  (nullishFallbackRef / nullishFallback / nullishControl)
 *   Layer 3  — Catch         (catchFallbackRef / catchFallback / catchControl)
 *
 * After layers 1–2b, the overdefinition boundary (`!= null`) decides whether
 * to return or continue to the next wire.
 *
 * ---
 *
 * Fast path: single `from` wire with no fallback/catch modifiers, which is
 * the common case for element field wires like `.id <- it.id`.  Delegates to
 * `resolveWiresAsync` for anything more complex.
 * See docs/performance.md (#10).
 */
export declare function resolveWires(ctx: TreeContext, wires: Wire[], pullChain?: Set<string>): MaybePromise<any>;
//# sourceMappingURL=resolveWires.d.ts.map