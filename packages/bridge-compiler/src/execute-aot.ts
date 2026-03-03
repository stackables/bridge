/**
 * AOT execution entry point — compile-once, run-many bridge execution.
 *
 * Compiles a bridge operation into a standalone async function on first call,
 * caches the compiled function, and re-uses it on subsequent calls for
 * zero-overhead execution.
 */

import type { BridgeDocument, ToolMap, Logger } from "@stackables/bridge-core";
import { compileBridge } from "./codegen.ts";

// ── Types ───────────────────────────────────────────────────────────────────

export type ExecuteAotOptions = {
  /** Parsed bridge document (from `parseBridge`). */
  document: BridgeDocument;
  /**
   * Which bridge to execute, as `"Type.field"`.
   * Example: `"Query.searchTrains"` or `"Mutation.sendEmail"`.
   */
  operation: string;
  /** Input arguments — equivalent to GraphQL field arguments. */
  input?: Record<string, unknown>;
  /**
   * Tool functions available to the engine.
   * Flat or namespaced: `{ myNamespace: { myTool } }`.
   */
  tools?: ToolMap;
  /** Context available via `with context as ctx` inside the bridge. */
  context?: Record<string, unknown>;
  /** External abort signal — cancels execution when triggered. */
  signal?: AbortSignal;
  /**
   * Hard timeout for tool calls in milliseconds.
   * Tools that exceed this duration throw an error.
   * Default: 0 (disabled).
   */
  toolTimeoutMs?: number;
  /** Structured logger for tool calls. */
  logger?: Logger;
};

export type ExecuteAotResult<T = unknown> = {
  data: T;
};

// ── Cache ───────────────────────────────────────────────────────────────────

type AotFn = (
  input: Record<string, unknown>,
  tools: Record<string, any>,
  context: Record<string, unknown>,
  opts?: { signal?: AbortSignal; toolTimeoutMs?: number; logger?: Logger },
) => Promise<any>;

const AsyncFunction = Object.getPrototypeOf(async function () {})
  .constructor as typeof Function;

/**
 * Cache: one compiled function per (document identity × operation).
 * Uses a WeakMap keyed on the document object so entries are GC'd when
 * the document is no longer referenced.
 */
const fnCache = new WeakMap<BridgeDocument, Map<string, AotFn>>();

function getOrCompile(document: BridgeDocument, operation: string): AotFn {
  let opMap = fnCache.get(document);
  if (opMap) {
    const cached = opMap.get(operation);
    if (cached) return cached;
  }

  const { functionBody } = compileBridge(document, { operation });

  const fn = new AsyncFunction(
    "input",
    "tools",
    "context",
    "__opts",
    functionBody,
  ) as AotFn;

  if (!opMap) {
    opMap = new Map();
    fnCache.set(document, opMap);
  }
  opMap.set(operation, fn);
  return fn;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Execute a bridge operation using AOT-compiled code.
 *
 * On first call for a given (document, operation) pair, compiles the bridge
 * into a standalone JavaScript function and caches it. Subsequent calls
 * reuse the cached function for zero-overhead execution.
 *
 * @example
 * ```ts
 * import { parseBridge } from "@stackables/bridge-parser";
 * import { executeAot } from "@stackables/bridge-compiler";
 *
 * const document = parseBridge(readFileSync("my.bridge", "utf8"));
 * const { data } = await executeAot({
 *   document,
 *   operation: "Query.myField",
 *   input: { city: "Berlin" },
 *   tools: { myApi: async (input) => fetch(...) },
 * });
 * ```
 */
export async function executeAot<T = unknown>(
  options: ExecuteAotOptions,
): Promise<ExecuteAotResult<T>> {
  const {
    document,
    operation,
    input = {},
    tools = {},
    context = {},
    signal,
    toolTimeoutMs,
    logger,
  } = options;

  const fn = getOrCompile(document, operation);
  const opts = signal || toolTimeoutMs || logger
    ? { signal, toolTimeoutMs, logger }
    : undefined;
  const data = await fn(input, tools as Record<string, any>, context, opts);
  return { data: data as T };
}
