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

// ── Tracing & error formatting ──────────────────────────────────────────────

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
  isFatalError,
  isLoopControlSignal,
  wrapBridgeRuntimeError,
} from "./tree-types.ts";
export type { Logger } from "./tree-types.ts";

// ── Types ───────────────────────────────────────────────────────────────────

export { SELF_MODULE } from "./types.ts";
export type {
  BinaryOp,
  Bridge,
  BridgeDocument,
  BatchToolCallFn,
  BatchToolFn,
  CacheStore,
  ConstDef,
  ControlFlowInstruction,
  DefineDef,
  Expression,
  ForceStatement,
  HandleBinding,
  Instruction,
  JsonValue,
  NodeRef,
  ScopeStatement,
  SourceLocation,
  ScalarToolCallFn,
  ScalarToolFn,
  SourceChain,
  SpreadStatement,
  Statement,
  ToolCallFn,
  ToolContext,
  ToolDef,
  ToolMap,
  ToolMetadata,
  VersionDecl,
  WireAliasStatement,
  WireCatch,
  WireSourceEntry,
  WireStatement,
  WithStatement,
} from "./types.ts";

// ── Traversal enumeration ───────────────────────────────────────────────────

export {
  buildTraversalManifest,
  buildTraversalManifest as enumerateTraversalIds,
  buildBodyTraversalMaps,
  decodeExecutionTrace,
  buildEmptyArrayBitsMap,
} from "./enumerate-traversals.ts";
export type { TraversalEntry, TraceWireBits } from "./enumerate-traversals.ts";

// ── Utilities ───────────────────────────────────────────────────────────────

export { parsePath } from "./utils.ts";
export {
  matchesRequestedFields,
  filterOutputFields,
} from "./requested-fields.ts";
