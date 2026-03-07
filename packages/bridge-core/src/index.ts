/**
 * @stackables/bridge-core — The Bridge runtime engine.
 *
 * Contains the execution engine, type system, internal tools (math, logic,
 * string concat), and utilities.  Given pre-parsed `Instruction[]` (JSON AST),
 * you can execute a bridge without pulling in the parser (Chevrotain) or
 * GraphQL dependencies.
 */

// ── Runtime engine ──────────────────────────────────────────────────────────

export { executeBridge } from "./execute-bridge.ts";
export type {
  ExecuteBridgeOptions,
  ExecuteBridgeResult,
} from "./execute-bridge.ts";

// ── Version check ───────────────────────────────────────────────────────────

export {
  checkStdVersion,
  checkHandleVersions,
  collectVersionedHandles,
  getBridgeVersion,
  hasVersionedToolFn,
  resolveStd,
} from "./version-check.ts";

// ── Document utilities ──────────────────────────────────────────────────────

export { mergeBridgeDocuments } from "./merge-documents.ts";

// ── Execution tree (advanced) ───────────────────────────────────────────────

export { ExecutionTree } from "./ExecutionTree.ts";
export { TraceCollector, boundedClone } from "./tracing.ts";
export type { ToolTrace, TraceLevel } from "./tracing.ts";
export {
  formatBridgeError,
  attachBridgeErrorDocumentContext,
} from "./formatBridgeError.ts";
export type {
  FormatBridgeErrorOptions,
  BridgeErrorDocumentContext,
} from "./formatBridgeError.ts";
export {
  BridgeAbortError,
  BridgePanicError,
  BridgeRuntimeError,
  BridgeTimeoutError,
  MAX_EXECUTION_DEPTH,
} from "./tree-types.ts";
export type { Logger } from "./tree-types.ts";

// ── Types ───────────────────────────────────────────────────────────────────

export { SELF_MODULE } from "./types.ts";
export type {
  Bridge,
  BridgeDocument,
  CacheStore,
  ConstDef,
  ControlFlowInstruction,
  DefineDef,
  HandleBinding,
  Instruction,
  NodeRef,
  SourceLocation,
  ToolCallFn,
  ToolContext,
  ToolDef,
  ToolDep,
  ToolMap,
  ToolMetadata,
  ToolWire,
  VersionDecl,
  Wire,
  WireFallback,
} from "./types.ts";

// ── Utilities ───────────────────────────────────────────────────────────────

export { parsePath } from "./utils.ts";
export {
  matchesRequestedFields,
  filterOutputFields,
} from "./requested-fields.ts";
