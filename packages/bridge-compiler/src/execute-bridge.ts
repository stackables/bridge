/**
 * AOT execution entry point — compile-once, run-many bridge execution.
 *
 * Compiles a bridge operation into a standalone async function on first call,
 * caches the compiled function, and re-uses it on subsequent calls for
 * zero-overhead execution.
 */

import type {
  BridgeDocument,
  ToolMap,
  Logger,
  ToolTrace,
  TraceLevel,
} from "@stackables/bridge-core";
import {
  TraceCollector,
  BridgePanicError,
  BridgeAbortError,
} from "@stackables/bridge-core";
import { std as bundledStd } from "@stackables/bridge-stdlib";
import { compileBridge } from "./codegen.ts";

// ── Types ───────────────────────────────────────────────────────────────────

export type ExecuteBridgeOptions = {
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
  /**
   * Enable tool-call tracing.
   * - `"off"` (default) — no collection, zero overhead
   * - `"basic"` — tool, fn, timing, errors; no input/output
   * - `"full"` — everything including input and output
   */
  trace?: TraceLevel;
  /**
   * Sparse fieldset filter.
   *
   * When provided, only the listed output fields (and their transitive
   * dependencies) are compiled and executed.  Tools that feed exclusively
   * into unrequested fields are eliminated by the compiler's dead-code
   * analysis (Kahn's algorithm).
   *
   * Supports dot-separated paths and a trailing wildcard:
   *   `["id", "price", "legs.*"]`
   *
   * Omit or pass an empty array to resolve all fields (the default).
   */
  requestedFields?: string[];
};

export type ExecuteBridgeResult<T = unknown> = {
  data: T;
  traces: ToolTrace[];
};

// ── Cache ───────────────────────────────────────────────────────────────────

type BridgeFn = (
  input: Record<string, unknown>,
  tools: Record<string, any>,
  context: Record<string, unknown>,
  opts?: {
    signal?: AbortSignal;
    toolTimeoutMs?: number;
    logger?: Logger;
    __trace?: (
      toolName: string,
      start: number,
      end: number,
      input: any,
      output: any,
      error: any,
    ) => void;
    __BridgePanicError?: new (...args: any[]) => Error;
    __BridgeAbortError?: new (...args: any[]) => Error;
  },
) => Promise<any>;

const AsyncFunction = Object.getPrototypeOf(async function () {})
  .constructor as typeof Function;

/**
 * Cache: one compiled function per (document identity × operation × requestedFields).
 * Uses a WeakMap keyed on the document object so entries are GC'd when
 * the document is no longer referenced.
 */
const fnCache = new WeakMap<BridgeDocument, Map<string, BridgeFn>>();

/** Build a cache key that includes the sorted requestedFields. */
function cacheKey(
  operation: string,
  requestedFields?: string[],
): string {
  if (!requestedFields || requestedFields.length === 0) return operation;
  return `${operation}:${[...requestedFields].sort().join(",")}`;
}

function getOrCompile(
  document: BridgeDocument,
  operation: string,
  requestedFields?: string[],
): BridgeFn {
  const key = cacheKey(operation, requestedFields);
  let opMap = fnCache.get(document);
  if (opMap) {
    const cached = opMap.get(key);
    if (cached) return cached;
  }

  const { functionBody } = compileBridge(document, {
    operation,
    requestedFields,
  });

  let fn: BridgeFn;
  try {
    fn = new AsyncFunction(
      "input",
      "tools",
      "context",
      "__opts",
      functionBody,
    ) as BridgeFn;
  } catch (err) {
    // CRITICAL: Attach the generated code so developers can actually debug the syntax error
    console.error(
      `\n[Bridge Compiler Error] Failed to compile operation: ${operation}\n`,
    );
    console.error("--- GENERATED CODE ---");
    console.error(functionBody);
    console.error("----------------------\n");
    throw new Error(
      `Bridge compilation failed for '${operation}': ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  if (!opMap) {
    opMap = new Map();
    fnCache.set(document, opMap);
  }
  opMap.set(key, fn);
  return fn;
}

// ── Tool flattening ─────────────────────────────────────────────────────────

/**
 * Flatten a nested tool map into dotted-key entries.
 *
 * The generated code accesses tools via flat keys like `tools["std.str.toUpperCase"]`.
 * This function converts nested structures (`{ std: { str: { toUpperCase: fn } } }`)
 * into the flat form the generated code expects.
 *
 * Already-flat entries (e.g. `"std.httpCall": fn`) are preserved as-is.
 */
function flattenTools(
  obj: Record<string, any>,
  prefix = "",
): Record<string, any> {
  const flat: Record<string, any> = {};
  for (const key of Object.keys(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const val = obj[key];
    if (typeof val === "function") {
      flat[fullKey] = val;
    } else if (val != null && typeof val === "object") {
      Object.assign(flat, flattenTools(val, fullKey));
    }
  }
  return flat;
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
 * import { executeBridge } from "@stackables/bridge-compiler";
 *
 * const document = parseBridge(readFileSync("my.bridge", "utf8"));
 * const { data } = await executeBridge({
 *   document,
 *   operation: "Query.myField",
 *   input: { city: "Berlin" },
 *   tools: { myApi: async (input) => fetch(...) },
 * });
 * ```
 */
export async function executeBridge<T = unknown>(
  options: ExecuteBridgeOptions,
): Promise<ExecuteBridgeResult<T>> {
  const {
    document,
    operation,
    input = {},
    tools: userTools = {},
    context = {},
    signal,
    toolTimeoutMs,
    logger,
  } = options;

  const fn = getOrCompile(document, operation, options.requestedFields);

  // Merge built-in std namespace with user-provided tools, then flatten
  // so the generated code can access them via dotted keys like tools["std.str.toUpperCase"].
  const allTools: ToolMap = { std: bundledStd, ...userTools };
  const flatTools = flattenTools(allTools as Record<string, any>);

  // Set up tracing if requested
  const traceLevel = options.trace ?? "off";
  let tracer: TraceCollector | undefined;
  if (traceLevel !== "off") {
    tracer = new TraceCollector(traceLevel);
  }

  const opts: NonNullable<Parameters<BridgeFn>[3]> = {
    signal,
    toolTimeoutMs,
    logger,
    __BridgePanicError: BridgePanicError,
    __BridgeAbortError: BridgeAbortError,
    __trace: tracer
      ? (
          toolName: string,
          start: number,
          end: number,
          toolInput: any,
          output: any,
          error: any,
        ) => {
          const startedAt = tracer!.now();
          const durationMs = Math.round((end - start) * 1000) / 1000;
          tracer!.record(
            tracer!.entry({
              tool: toolName,
              fn: toolName,
              startedAt: Math.max(0, startedAt - durationMs),
              durationMs,
              input: toolInput,
              output,
              error:
                error instanceof Error
                  ? error.message
                  : error
                    ? String(error)
                    : undefined,
            }),
          );
        }
      : undefined,
  };
  const data = await fn(input, flatTools, context, opts);
  return { data: data as T, traces: tracer?.traces ?? [] };
}
