/**
 * @stackables/core-native — Ahead-of-time compiler for Bridge files.
 *
 * Compiles a BridgeDocument into a standalone JavaScript function that
 * executes the same data flow without the ExecutionTree runtime overhead.
 *
 * @packageDocumentation
 */

export { compileBridge } from "./codegen.ts";
export type { CompileResult, CompileOptions } from "./codegen.ts";

export { executeAot } from "./execute-aot.ts";
export type { ExecuteAotOptions, ExecuteAotResult } from "./execute-aot.ts";
