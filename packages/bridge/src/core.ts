/**
 * Bridge Core — the minimal runtime engine.
 *
 * Contains the execution engine, type system, internal tools (math, logic,
 * string concat), and utilities.  This is the smallest useful subset: given
 * pre-parsed `Instruction[]` (JSON AST), you can execute a bridge without
 * pulling in the parser (Chevrotain) or GraphQL dependencies.
 *
 * ```ts
 * import { executeBridge } from "@stackables/bridge/core";
 * import type { Instruction } from "@stackables/bridge/core";
 * ```
 */

// ── Runtime engine ──────────────────────────────────────────────────────────

export { executeBridge } from "./execute-bridge.ts";
export type {
  ExecuteBridgeOptions,
  ExecuteBridgeResult,
} from "./execute-bridge.ts";

// ── Error classes ───────────────────────────────────────────────────────────

export { BridgeAbortError, BridgePanicError } from "./ExecutionTree.ts";
export type { Logger, ToolTrace, TraceLevel } from "./ExecutionTree.ts";

// ── Internal tools (core language primitives) ───────────────────────────────

export { internal } from "./tools/index.ts";

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
  Wire,
} from "./types.ts";

// ── Utilities ───────────────────────────────────────────────────────────────

export { parsePath } from "./utils.ts";
