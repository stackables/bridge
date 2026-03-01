/**
 * Tracing and OpenTelemetry instrumentation for the execution engine.
 *
 * Extracted from ExecutionTree.ts — Phase 1 of the refactor.
 * See docs/execution-tree-refactor.md
 */

import { metrics, trace } from "@opentelemetry/api";
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

// Re-export SpanStatusCode for callTool usage
export { SpanStatusCode as SpanStatusCodeEnum } from "@opentelemetry/api";

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
 * Bounded serialization for trace payloads — prevents OOM when tools handle
 * very large objects (e.g. a 50 MB database response).
 *
 * Truncates:
 *  - Arrays beyond `maxArrayItems` elements (default 100)
 *  - Strings beyond `maxStringLength` characters (default 1 024)
 *  - Object trees deeper than `maxDepth` levels (default 5)
 */
export function boundedClone(
  value: unknown,
  depth = 0,
  maxDepth = 5,
  maxArrayItems = 100,
  maxStringLength = 1024,
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.length > maxStringLength
      ? value.slice(0, maxStringLength) + `…[+${value.length - maxStringLength}]`
      : value;
  }
  if (typeof value !== "object") return value;
  if (depth >= maxDepth) return "[…]";
  if (Array.isArray(value)) {
    const truncated = value.length > maxArrayItems;
    const items: unknown[] = (
      truncated ? value.slice(0, maxArrayItems) : value
    ).map((item) =>
      boundedClone(item, depth + 1, maxDepth, maxArrayItems, maxStringLength),
    );
    if (truncated) items.push(`…[+${value.length - maxArrayItems} more]`);
    return items;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(
    value as Record<string, unknown>,
  )) {
    out[k] = boundedClone(
      v,
      depth + 1,
      maxDepth,
      maxArrayItems,
      maxStringLength,
    );
  }
  return out;
}

/** Shared trace collector — one per request, passed through the tree. */
export class TraceCollector {
  readonly traces: ToolTrace[] = [];
  readonly level: "basic" | "full";
  /** Maximum number of array elements captured in a trace payload. */
  readonly maxArrayItems: number;
  /** Maximum string length (characters) captured in a trace payload. */
  readonly maxStringLength: number;
  /** Maximum object nesting depth captured in a trace payload. */
  readonly cloneDepth: number;
  private readonly epoch = performance.now();

  constructor(
    level: "basic" | "full" = "full",
    maxArrayItems = 100,
    maxStringLength = 1024,
    cloneDepth = 5,
  ) {
    this.level = level;
    this.maxArrayItems = maxArrayItems;
    this.maxStringLength = maxStringLength;
    this.cloneDepth = cloneDepth;
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
    if (base.input)
      t.input = boundedClone(
        base.input,
        0,
        this.cloneDepth,
        this.maxArrayItems,
        this.maxStringLength,
      ) as Record<string, any>;
    if (base.error) t.error = base.error;
    else if (base.output !== undefined) t.output = base.output;
    return t;
  }
}
