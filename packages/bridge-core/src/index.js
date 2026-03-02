/**
 * @stackables/bridge-core — The Bridge runtime engine.
 *
 * Contains the execution engine, type system, internal tools (math, logic,
 * string concat), and utilities.  Given pre-parsed `Instruction[]` (JSON AST),
 * you can execute a bridge without pulling in the parser (Chevrotain) or
 * GraphQL dependencies.
 */
// ── Runtime engine ──────────────────────────────────────────────────────────
export { executeBridge } from "./execute-bridge.js";
// ── Version check ───────────────────────────────────────────────────────────
export { checkStdVersion, checkHandleVersions, collectVersionedHandles, getBridgeVersion, hasVersionedToolFn, resolveStd, } from "./version-check.js";
// ── Document utilities ──────────────────────────────────────────────────────
export { mergeBridgeDocuments } from "./merge-documents.js";
// ── Execution tree (advanced) ───────────────────────────────────────────────
export { ExecutionTree } from "./ExecutionTree.js";
export { TraceCollector, boundedClone } from "./tracing.js";
export { BridgeAbortError, BridgePanicError, BridgeTimeoutError, MAX_EXECUTION_DEPTH, } from "./tree-types.js";
// ── Types ───────────────────────────────────────────────────────────────────
export { SELF_MODULE } from "./types.js";
// ── Utilities ───────────────────────────────────────────────────────────────
export { parsePath } from "./utils.js";
