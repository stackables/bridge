/**
 * @stackables/bridge — Meta-package re-exporting everything.
 *
 * For consumers who want one import and don't care about bundle size.
 * Equivalent to the original single-package experience.
 */

// ── Core (runtime engine, types, internal tools) ────────────────────────────

export {
  executeBridge,
  ExecutionTree,
  TraceCollector,
  BridgeAbortError,
  BridgePanicError,
  internal,
  SELF_MODULE,
  parsePath,
} from "@stackables/bridge-core";
export type {
  ExecuteBridgeOptions,
  ExecuteBridgeResult,
  Logger,
  ToolTrace,
  TraceLevel,
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
} from "@stackables/bridge-core";

// ── Compiler (parser, serializer, language service) ─────────────────────────

export {
  parseBridgeChevrotain as parseBridge,
  parseBridgeChevrotain,
  parseBridgeDiagnostics,
  BridgeLanguageService,
  serializeBridge,
} from "@stackables/bridge-compiler";
export type {
  BridgeDiagnostic,
  BridgeParseResult,
  BridgeCompletion,
  BridgeHover,
  CompletionKind,
  Position,
  Range,
} from "@stackables/bridge-compiler";

// ── GraphQL adapter ─────────────────────────────────────────────────────────

export {
  bridgeTransform,
  getBridgeTraces,
  useBridgeTracing,
} from "@stackables/bridge-graphql";
export type { BridgeOptions, InstructionSource } from "@stackables/bridge-graphql";

// ── Standard library ────────────────────────────────────────────────────────

export {
  std,
  createHttpCall,
} from "@stackables/bridge-stdlib";

// ── Convenience: combined builtinTools for backward compatibility ───────────

import { internal } from "@stackables/bridge-core";
import type { ToolMap } from "@stackables/bridge-core";
import { std } from "@stackables/bridge-stdlib";

export const builtinTools: ToolMap = {
  std,
  internal,
};

export const builtinToolNames: readonly string[] = [
  ...Object.keys(std).map((k) => `std.${k}`),
  ...Object.keys(internal).map((k) => `internal.${k}`),
];
