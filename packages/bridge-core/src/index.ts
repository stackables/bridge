/**
 * @stackables/bridge-core — The Bridge runtime engine.
 *
 * Contains the execution engine, type system, internal tools (math, logic,
 * string concat), and utilities.  Given pre-parsed `Instruction[]` (JSON AST),
 * you can execute a bridge without pulling in the parser (Chevrotain) or
 * GraphQL dependencies.
 */

// ── Tagged template literal ──────────────────────────────────────────────────

export { bridge } from "./tag.ts";

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
  isLoopControlSignal,
} from "./tree-types.ts";
export type { Logger } from "./tree-types.ts";

// ── Types ───────────────────────────────────────────────────────────────────

export { SELF_MODULE } from "./types.ts";
export type {
  Bridge,
  BridgeDocument,
  BatchToolCallFn,
  BatchToolFn,
  CacheStore,
  ConstDef,
  ControlFlowInstruction,
  DefineDef,
  Expression,
  HandleBinding,
  Instruction,
  NodeRef,
  SourceLocation,
  ScalarToolCallFn,
  ScalarToolFn,
  ToolCallFn,
  ToolContext,
  ToolDef,
  ToolMap,
  ToolMetadata,
  VersionDecl,
  Wire,
  WireCatch,
  WireFallback,
  WireSourceEntry,
  WireV2,
} from "./types.ts";

// ── Wire compatibility layer ────────────────────────────────────────────────

export {
  legacyToV2,
  v2ToLegacy,
  getSimplePullRefV2,
  isRefExpr,
  isLiteralExpr,
  isTernaryExpr,
  isAndExpr,
  isOrExpr,
  isControlExpr,
} from "./wire-compat.ts";

// ── Wire resolution V2 ─────────────────────────────────────────────────────

export {
  evaluateExpression,
  resolveSourceEntries,
  applyFallbackGatesV2,
  applyCatchV2,
} from "./resolveWiresV2.ts";

// ── Traversal enumeration ───────────────────────────────────────────────────

export {
  enumerateTraversalIds,
  buildTraversalManifest,
  decodeExecutionTrace,
  buildTraceBitsMap,
  buildEmptyArrayBitsMap,
} from "./enumerate-traversals.ts";
export type { TraversalEntry, TraceWireBits } from "./enumerate-traversals.ts";

// ── Utilities ───────────────────────────────────────────────────────────────

export { parsePath } from "./utils.ts";
export {
  matchesRequestedFields,
  filterOutputFields,
} from "./requested-fields.ts";
