/**
 * Tracing and OpenTelemetry instrumentation for the execution engine.
 *
 * Extracted from ExecutionTree.ts — Phase 1 of the refactor.
 * See docs/execution-tree-refactor.md
 */

import { metrics, trace } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";
import type { ToolMetadata } from "@stackables/bridge-types";
import type { Logger } from "./tree-types.ts";
import { roundMs } from "./tree-utils.ts";

// ── OTel setup ──────────────────────────────────────────────────────────────

export const otelTracer = trace.getTracer("@stackables/bridge");

/**
 * Lazily detect whether the OpenTelemetry tracer is a real (recording)
 * tracer or the default no-op.  Probed once on first tool call; result
 * is cached for the lifetime of the process.
 *
 * If the SDK has not been registered by the time the first tool runs,
 * all subsequent calls will skip OTel instrumentation.
 */
let _otelActive: boolean | undefined;
export function isOtelActive(): boolean {
  if (_otelActive === undefined) {
    const probe = otelTracer.startSpan("_bridge_probe_");
    _otelActive = probe.isRecording();
    probe.end();
  }
  return _otelActive;
}

const otelMeter = metrics.getMeter("@stackables/bridge");
export const toolCallCounter = otelMeter.createCounter("bridge.tool.calls", {
  description: "Total number of tool invocations",
});
export const toolDurationHistogram = otelMeter.createHistogram(
  "bridge.tool.duration",
  {
    description: "Tool call duration in milliseconds",
    unit: "ms",
  },
);
export const toolErrorCounter = otelMeter.createCounter("bridge.tool.errors", {
  description: "Total number of tool invocation errors",
});

// Re-export SpanStatusCode for internal usage
export { SpanStatusCode as SpanStatusCodeEnum } from "@opentelemetry/api";
import { SpanStatusCode } from "@opentelemetry/api";

// ── Trace types ─────────────────────────────────────────────────────────────

/** Trace verbosity level.
 *  - `"off"` (default) — no collection, zero overhead
 *  - `"basic"` — tool, fn, timing, errors; no input/output
 *  - `"full"` — everything including input and output */
export type TraceLevel = "basic" | "full" | "off";

/** A single recorded tool invocation. */
export type ToolTrace = {
  /** Tool name as resolved (e.g. "hereGeo", "std.str.toUpperCase") */
  tool: string;
  /** The function that was called (e.g. "httpCall", "upperCase") */
  fn: string;
  /** Input object passed to the tool function (only in "full" level) */
  input?: Record<string, any>;
  /** Resolved output (only in "full" level, on success) */
  output?: any;
  /** Error message (present when the tool threw) */
  error?: string;
  /** Wall-clock duration in milliseconds */
  durationMs: number;
  /** Monotonic timestamp (ms) relative to the first trace in the request */
  startedAt: number;
};

// ── TraceCollector ──────────────────────────────────────────────────────────

/**
 * Bounded clone utility — replaces `structuredClone` for trace data.
 * Truncates arrays, strings, and deep objects to prevent OOM when
 * tracing large payloads.
 */
export function boundedClone(
  value: unknown,
  maxArrayItems = 100,
  maxStringLength = 1024,
  depth = 5,
): unknown {
  // Clamp parameters to sane ranges to prevent RangeError from new Array()
  const safeArrayItems = Math.max(
    0,
    Number.isFinite(maxArrayItems) ? Math.floor(maxArrayItems) : 100,
  );
  const safeStringLength = Math.max(
    0,
    Number.isFinite(maxStringLength) ? Math.floor(maxStringLength) : 1024,
  );
  const safeDepth = Math.max(0, Number.isFinite(depth) ? Math.floor(depth) : 5);
  return _boundedClone(value, safeArrayItems, safeStringLength, safeDepth, 0);
}

function _boundedClone(
  value: unknown,
  maxArrayItems: number,
  maxStringLength: number,
  maxDepth: number,
  currentDepth: number,
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (value.length > maxStringLength) {
      return value.slice(0, maxStringLength) + `... (${value.length} chars)`;
    }
    return value;
  }
  if (typeof value !== "object") return value; // number, boolean, bigint, symbol
  if (currentDepth >= maxDepth) return "[depth limit]";

  if (Array.isArray(value)) {
    const len = Math.min(value.length, maxArrayItems);
    const result = new Array(len);
    for (let i = 0; i < len; i++) {
      result[i] = _boundedClone(
        value[i],
        maxArrayItems,
        maxStringLength,
        maxDepth,
        currentDepth + 1,
      );
    }
    if (value.length > maxArrayItems) {
      result.push(`... (${value.length} items)`);
    }
    return result;
  }

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    result[key] = _boundedClone(
      (value as Record<string, unknown>)[key],
      maxArrayItems,
      maxStringLength,
      maxDepth,
      currentDepth + 1,
    );
  }
  return result;
}

/** Shared trace collector — one per request, passed through the tree. */
export class TraceCollector {
  readonly traces: ToolTrace[] = [];
  readonly level: "basic" | "full";
  private readonly epoch = performance.now();
  /** Max array items to keep in bounded clone (configurable). */
  readonly maxArrayItems: number;
  /** Max string length to keep in bounded clone (configurable). */
  readonly maxStringLength: number;
  /** Max object depth to keep in bounded clone (configurable). */
  readonly cloneDepth: number;

  constructor(
    level: "basic" | "full" = "full",
    options?: {
      maxArrayItems?: number;
      maxStringLength?: number;
      cloneDepth?: number;
    },
  ) {
    this.level = level;
    this.maxArrayItems = options?.maxArrayItems ?? 100;
    this.maxStringLength = options?.maxStringLength ?? 1024;
    this.cloneDepth = options?.cloneDepth ?? 5;
  }

  /** Returns ms since the collector was created */
  now(): number {
    return roundMs(performance.now() - this.epoch);
  }

  record(trace: ToolTrace): void {
    this.traces.push(trace);
  }

  /** Build a trace entry, omitting input/output for basic level. */
  entry(base: {
    tool: string;
    fn: string;
    startedAt: number;
    durationMs: number;
    input?: Record<string, any>;
    output?: any;
    error?: string;
  }): ToolTrace {
    if (this.level === "basic") {
      const t: ToolTrace = {
        tool: base.tool,
        fn: base.fn,
        durationMs: base.durationMs,
        startedAt: base.startedAt,
      };
      if (base.error) t.error = base.error;
      return t;
    }
    // full
    const t: ToolTrace = {
      tool: base.tool,
      fn: base.fn,
      durationMs: base.durationMs,
      startedAt: base.startedAt,
    };
    if (base.input) {
      const clonedInput = boundedClone(
        base.input,
        this.maxArrayItems,
        this.maxStringLength,
        this.cloneDepth,
      );
      if (clonedInput && typeof clonedInput === "object") {
        t.input = clonedInput as Record<string, any>;
      }
    }
    if (base.error) t.error = base.error;
    else if (base.output !== undefined) t.output = base.output;
    return t;
  }
}

// ── Tool metadata helpers ────────────────────────────────────────────────────

/**
 * Resolved logging behaviour derived from a tool's `.bridge` metadata.
 * A fixed shape so call sites never branch on `undefined`.
 */
export type EffectiveToolLog = {
  /** Logger level for successful invocations, or `false` to suppress. */
  execution: false | "debug" | "info";
  /** Logger level for thrown errors, or `false` to suppress. */
  errors: false | "warn" | "error";
};

/** Normalised metadata resolved from the optional `.bridge` property. */
export type ResolvedToolMeta = {
  /** Emit an OTel span for this call. Default: `true`. */
  doTrace: boolean;
  log: EffectiveToolLog;
};

function resolveToolLog(meta: ToolMetadata | undefined): EffectiveToolLog {
  const log = meta?.log;
  if (log === false) return { execution: false, errors: false };
  if (log == null) return { execution: false, errors: "error" };
  if (log === true) return { execution: "info", errors: "error" };
  return {
    execution:
      log.execution === "info" ? "info" : log.execution ? "debug" : false,
    errors:
      log.errors === false ? false : log.errors === "warn" ? "warn" : "error",
  };
}

/** Read and normalise the `.bridge` metadata from a tool function. */
export function resolveToolMeta(fn: (...args: any[]) => any): ResolvedToolMeta {
  const bridge = (fn as any).bridge as ToolMetadata | undefined;
  return { doTrace: bridge?.trace !== false, log: resolveToolLog(bridge) };
}

/** Log a successful tool invocation. No-ops when `level` is `false`. */
export function logToolSuccess(
  logger: Logger | undefined,
  level: EffectiveToolLog["execution"],
  toolName: string,
  fnName: string,
  durationMs: number,
): void {
  if (!level) return;
  logger?.[level]?.(
    { tool: toolName, fn: fnName, durationMs },
    "[bridge] tool completed",
  );
}

/** Log a tool error. No-ops when `level` is `false`. */
export function logToolError(
  logger: Logger | undefined,
  level: EffectiveToolLog["errors"],
  toolName: string,
  fnName: string,
  err: Error,
): void {
  if (!level) return;
  logger?.[level]?.(
    { tool: toolName, fn: fnName, err: err.message },
    "[bridge] tool failed",
  );
}

/** Record an exception on a span and mark it as errored. */
export function recordSpanError(span: Span | undefined, err: Error): void {
  if (!span) return;
  span.recordException(err);
  span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
}

/**
 * Run `fn` inside an OTel span when `doTrace` is true;
 * otherwise call it directly with `undefined` as the span argument.
 */
export function withSpan<T>(
  doTrace: boolean,
  name: string,
  attrs: Record<string, string>,
  fn: (span: Span | undefined) => Promise<T>,
): Promise<T> {
  if (!doTrace) return fn(undefined);
  return otelTracer.startActiveSpan(name, { attributes: attrs }, fn);
}

/**
 * Synchronous variant of `withSpan` — runs `fn` inside an OTel span
 * without introducing a Promise.  Used by the sync-tool instrumented
 * path so that `{sync: true, trace: true}` tools still produce spans.
 */
export function withSyncSpan<T>(
  doTrace: boolean,
  name: string,
  attrs: Record<string, string>,
  fn: (span: Span | undefined) => T,
): T {
  if (!doTrace) return fn(undefined);
  return otelTracer.startActiveSpan(name, { attributes: attrs }, fn);
}
