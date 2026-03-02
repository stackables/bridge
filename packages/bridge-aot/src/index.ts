/**
 * @stackables/bridge-aot — Ahead-of-time compiler for Bridge files.
 *
 * Compiles a BridgeDocument into a standalone JavaScript function that
 * executes the same data flow without the ExecutionTree runtime overhead.
 *
 * @packageDocumentation
 */

export { compileBridge } from "./codegen.ts";
export type { CompileResult, CompileOptions } from "./codegen.ts";
