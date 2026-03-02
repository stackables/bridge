/**
 * @stackables/bridge-core — The Bridge runtime engine.
 *
 * Contains the execution engine, type system, internal tools (math, logic,
 * string concat), and utilities.  Given pre-parsed `Instruction[]` (JSON AST),
 * you can execute a bridge without pulling in the parser (Chevrotain) or
 * GraphQL dependencies.
 */
export { executeBridge } from "./execute-bridge.ts";
export type { ExecuteBridgeOptions, ExecuteBridgeResult, } from "./execute-bridge.ts";
export { checkStdVersion, checkHandleVersions, collectVersionedHandles, getBridgeVersion, hasVersionedToolFn, resolveStd, } from "./version-check.ts";
export { mergeBridgeDocuments } from "./merge-documents.ts";
export { ExecutionTree } from "./ExecutionTree.ts";
export { TraceCollector, boundedClone } from "./tracing.ts";
export type { ToolTrace, TraceLevel } from "./tracing.ts";
export { BridgeAbortError, BridgePanicError, BridgeTimeoutError, MAX_EXECUTION_DEPTH, } from "./tree-types.ts";
export type { Logger } from "./tree-types.ts";
export { SELF_MODULE } from "./types.ts";
export type { Bridge, BridgeDocument, CacheStore, ConstDef, ControlFlowInstruction, DefineDef, HandleBinding, Instruction, NodeRef, ToolCallFn, ToolContext, ToolDef, ToolDep, ToolMap, ToolWire, VersionDecl, Wire, } from "./types.ts";
export { parsePath } from "./utils.ts";
//# sourceMappingURL=index.d.ts.map