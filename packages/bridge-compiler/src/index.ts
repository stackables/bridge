/**
 * @stackables/bridge-compiler — Compiles BridgeDocument into optimized JavaScript.
 *
 * Compiles a BridgeDocument into a standalone JavaScript function that
 * executes the same data flow without the ExecutionTree runtime overhead.
 *
 * @packageDocumentation
 */

export { compileBridge } from "./codegen.ts";
export type { CompileResult, CompileOptions } from "./codegen.ts";

export { executeBridge } from "./execute-bridge.ts";
export type {
  ExecuteBridgeOptions,
  ExecuteBridgeResult,
} from "./execute-bridge.ts";

// Re-export trace types from bridge-core for convenience
export type { TraceLevel, ToolTrace } from "@stackables/bridge-core";
