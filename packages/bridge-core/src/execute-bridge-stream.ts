/**
 * Streaming execution for bridge operations.
 *
 * `executeBridgeStream()` follows the GraphQL incremental delivery
 * specification: the first payload includes eagerly resolved data
 * (with stream fields initialised to `[]`), and subsequent payloads
 * deliver items from async-generator tools one at a time.
 *
 * Tools that declare `{ stream: true }` on their `.bridge` metadata
 * must return `AsyncGenerator<T>`.  The engine detects these via
 * `StreamHandle` sentinels injected by `callTool()`.
 */

import { ExecutionTree } from "./ExecutionTree.ts";
import { attachBridgeErrorDocumentContext } from "./formatBridgeError.ts";
import { TraceCollector } from "./tracing.ts";
import type { ToolTrace } from "./tracing.ts";
import type { ToolMap } from "./types.ts";
import { SELF_MODULE } from "./types.ts";
import type { ExecuteBridgeOptions } from "./execute-bridge.ts";
import {
  std as bundledStd,
  STD_VERSION as BUNDLED_STD_VERSION,
} from "@stackables/bridge-stdlib";
import { resolveStd, checkHandleVersions } from "./version-check.ts";

// ── Stream handle sentinel ──────────────────────────────────────────────────

/**
 * Internal sentinel that wraps an async generator returned by a stream tool.
 *
 * When the execution tree resolves a stream tool, `callTool()` wraps the
 * generator in a `StreamHandle` instead of consuming it.  After `tree.run()`
 * completes, `executeBridgeStream` scans the result tree for sentinels,
 * replaces them with `[]`, and iterates the generators to produce
 * incremental payloads.
 */
export class StreamHandle {
  constructor(
    public readonly generator: AsyncGenerator<unknown, void, undefined>,
    public readonly toolName: string,
  ) {}
}

/** Type guard for `StreamHandle` sentinels embedded in resolved data. */
export function isStreamHandle(value: unknown): value is StreamHandle {
  return value instanceof StreamHandle;
}

// ── Incremental delivery types ──────────────────────────────────────────────

/** First payload of an incremental delivery sequence. */
export type StreamInitialPayload<T = unknown> = {
  data: T;
  hasNext: boolean;
  traces?: ToolTrace[];
  executionTraceId?: bigint;
};

/** A single incremental item patch. */
export interface StreamIncrementalItem {
  items: unknown[];
  path: (string | number)[];
}

/** Subsequent payload with incremental patches. */
export type StreamIncrementalPayload = {
  incremental: StreamIncrementalItem[];
  hasNext: boolean;
};

/** Union of all payload types yielded by `executeBridgeStream()`. */
export type StreamPayload<T = unknown> =
  | StreamInitialPayload<T>
  | StreamIncrementalPayload;

// ── Helpers ─────────────────────────────────────────────────────────────────

interface FoundStream {
  handle: StreamHandle;
  path: (string | number)[];
}

/**
 * Walk the resolved data tree, replacing `StreamHandle` sentinels with `[]`
 * and collecting them with their paths for later iteration.
 */
function extractStreams(
  data: unknown,
  path: (string | number)[],
  found: FoundStream[],
): unknown {
  if (isStreamHandle(data)) {
    found.push({ handle: data, path: [...path] });
    return [];
  }
  if (Array.isArray(data)) {
    return data.map((item, i) => extractStreams(item, [...path, i], found));
  }
  if (data != null && typeof data === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = extractStreams(value, [...path, key], found);
    }
    return result;
  }
  return data;
}

// ── Main entry point ────────────────────────────────────────────────────────

/**
 * Execute a bridge operation with incremental streaming delivery.
 *
 * Returns an `AsyncGenerator` that yields payloads following the GraphQL
 * incremental delivery specification:
 *
 * 1. **Initial payload** — contains all eagerly resolved data.  Fields
 *    backed by stream tools (`{ stream: true }`) are initialised to `[]`.
 *    Includes `hasNext: true` when stream generators are pending.
 *
 * 2. **Incremental payloads** — one per yielded item from each stream
 *    generator.  Each payload carries an `incremental` array of patches
 *    with `items` and `path` (matching the GraphQL spec format).
 *
 * 3. **Final payload** — delivered with `hasNext: false` to signal
 *    completion.
 *
 * When no stream tools are present, a single payload with
 * `hasNext: false` is yielded (equivalent to `executeBridge()`).
 *
 * @example
 * ```ts
 * const stream = executeBridgeStream({
 *   document,
 *   operation: "Query.searchProducts",
 *   input: { query: "shoes" },
 *   tools: { aiSearch },
 * });
 *
 * for await (const payload of stream) {
 *   if ("data" in payload) {
 *     console.log("Initial:", payload.data);
 *   } else {
 *     console.log("Incremental:", payload.incremental);
 *   }
 *   if (!payload.hasNext) break;
 * }
 * ```
 */
export async function* executeBridgeStream<T = unknown>(
  options: ExecuteBridgeOptions,
): AsyncGenerator<StreamPayload<T>, void, undefined> {
  const { document: doc, operation, input = {}, context = {} } = options;

  const parts = operation.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Invalid operation "${operation}" — expected "Type.field" (e.g. "Query.myField")`,
    );
  }

  const [type, field] = parts as [string, string];
  const trunk = { module: SELF_MODULE, type, field };

  const userTools = options.tools ?? {};

  const { namespace: activeStd, version: activeStdVersion } = resolveStd(
    doc.version,
    bundledStd,
    BUNDLED_STD_VERSION,
    userTools,
  );

  const allTools: ToolMap = { std: activeStd, ...userTools };
  checkHandleVersions(doc.instructions, allTools, activeStdVersion);

  const tree = new ExecutionTree(trunk, doc, allTools, context);

  tree.source = doc.source;
  tree.filename = doc.filename;
  // Enable stream mode — callTool will wrap async generators in StreamHandle
  tree.streamMode = true;

  if (options.logger) tree.logger = options.logger;
  if (options.signal) tree.signal = options.signal;
  if (
    options.toolTimeoutMs !== undefined &&
    Number.isFinite(options.toolTimeoutMs) &&
    options.toolTimeoutMs >= 0
  ) {
    tree.toolTimeoutMs = Math.floor(options.toolTimeoutMs);
  }
  if (
    options.maxDepth !== undefined &&
    Number.isFinite(options.maxDepth) &&
    options.maxDepth >= 0
  ) {
    tree.maxDepth = Math.floor(options.maxDepth);
  }

  const traceLevel = options.trace ?? "off";
  if (traceLevel !== "off") {
    tree.tracer = new TraceCollector(traceLevel);
  }

  tree.enableExecutionTrace();

  let rawData: unknown;
  try {
    rawData = await tree.run(input, options.requestedFields);
  } catch (err) {
    if (err && typeof err === "object") {
      (err as { executionTraceId?: bigint }).executionTraceId =
        tree.getExecutionTrace();
    }
    throw attachBridgeErrorDocumentContext(err, doc);
  }

  // Scan resolved data for stream sentinels
  const streams: FoundStream[] = [];
  const data = extractStreams(rawData, [], streams) as T;

  const traces = tree.getTraces();
  const executionTraceId = tree.getExecutionTrace();

  if (streams.length === 0) {
    // No stream tools — single payload, equivalent to executeBridge()
    yield {
      data,
      hasNext: false,
      traces,
      executionTraceId,
    };
    return;
  }

  // Yield initial payload with stream fields initialised to []
  yield {
    data,
    hasNext: true,
    traces,
    executionTraceId,
  };

  // Iterate all stream generators concurrently.
  // Each yielded item becomes an incremental payload.
  const signal = options.signal;

  // Track active generators
  type ActiveStream = {
    iterator: AsyncGenerator<unknown, void, undefined>;
    path: (string | number)[];
    index: number;
    done: boolean;
  };

  const active: ActiveStream[] = streams.map((s) => ({
    iterator: s.handle.generator,
    path: s.path,
    index: 0,
    done: false,
  }));

  // Pull from all active generators concurrently
  while (active.some((s) => !s.done)) {
    if (signal?.aborted) break;

    // Race: get next item from any active generator
    const pending = active
      .filter((s) => !s.done)
      .map(async (stream) => {
        const result = await stream.iterator.next();
        return { stream, result };
      });

    // Wait for the first one to produce a value
    // Use Promise.allSettled to handle errors gracefully
    const results = await Promise.allSettled(pending);

    const incremental: StreamIncrementalItem[] = [];

    for (const settled of results) {
      if (settled.status === "rejected") {
        // Stream generator threw — mark as done, skip
        // Error is swallowed; the initial payload already delivered partial data
        continue;
      }
      const { stream, result } = settled.value;
      if (result.done) {
        stream.done = true;
        continue;
      }
      incremental.push({
        items: [result.value],
        path: [...stream.path, stream.index],
      });
      stream.index++;
    }

    if (incremental.length > 0) {
      const hasNext = active.some((s) => !s.done);
      yield { incremental, hasNext };
      if (!hasNext) return;
    }
  }

  // Final termination signal if we broke out of the loop
  yield { incremental: [], hasNext: false };
}
