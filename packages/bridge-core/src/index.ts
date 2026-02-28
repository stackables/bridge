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

export { checkStdVersion, getBridgeVersion } from "./version-check.ts";

// ── Execution tree (advanced) ───────────────────────────────────────────────

export {
  ExecutionTree,
  TraceCollector,
  BridgeAbortError,
  BridgePanicError,
} from "./ExecutionTree.ts";
export type { Logger, ToolTrace, TraceLevel } from "./ExecutionTree.ts";

// ── Types ───────────────────────────────────────────────────────────────────

export { SELF_MODULE } from "./types.ts";
export type {
  Bridge,
  CacheStore,
  ConstDef,
  ControlFlowInstruction,
  DefineDef,
  HandleBinding,
  Instruction,
  NodeRef,
  ToolCallFn,
  ToolContext,
  ToolDef,
  ToolDep,
  ToolMap,
  ToolWire,
  VersionDecl,
  Wire,
} from "./types.ts";

// ── Utilities ───────────────────────────────────────────────────────────────

export { parsePath } from "./utils.ts";
