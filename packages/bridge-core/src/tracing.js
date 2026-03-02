/**
 * Tracing and OpenTelemetry instrumentation for the execution engine.
 *
 * Extracted from ExecutionTree.ts — Phase 1 of the refactor.
 * See docs/execution-tree-refactor.md
 */
import { metrics, trace } from "@opentelemetry/api";
import { roundMs } from "./tree-utils.js";
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
let _otelActive;
export function isOtelActive() {
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
export const toolDurationHistogram = otelMeter.createHistogram("bridge.tool.duration", {
    description: "Tool call duration in milliseconds",
    unit: "ms",
});
export const toolErrorCounter = otelMeter.createCounter("bridge.tool.errors", {
    description: "Total number of tool invocation errors",
});
// Re-export SpanStatusCode for callTool usage
export { SpanStatusCode as SpanStatusCodeEnum } from "@opentelemetry/api";
// ── TraceCollector ──────────────────────────────────────────────────────────
/**
 * Bounded clone utility — replaces `structuredClone` for trace data.
 * Truncates arrays, strings, and deep objects to prevent OOM when
 * tracing large payloads.
 */
export function boundedClone(value, maxArrayItems = 100, maxStringLength = 1024, depth = 5) {
    // Clamp parameters to sane ranges to prevent RangeError from new Array()
    const safeArrayItems = Math.max(0, Number.isFinite(maxArrayItems) ? Math.floor(maxArrayItems) : 100);
    const safeStringLength = Math.max(0, Number.isFinite(maxStringLength) ? Math.floor(maxStringLength) : 1024);
    const safeDepth = Math.max(0, Number.isFinite(depth) ? Math.floor(depth) : 5);
    return _boundedClone(value, safeArrayItems, safeStringLength, safeDepth, 0);
}
function _boundedClone(value, maxArrayItems, maxStringLength, maxDepth, currentDepth) {
    if (value === null || value === undefined)
        return value;
    if (typeof value === "string") {
        if (value.length > maxStringLength) {
            return value.slice(0, maxStringLength) + `... (${value.length} chars)`;
        }
        return value;
    }
    if (typeof value !== "object")
        return value; // number, boolean, bigint, symbol
    if (currentDepth >= maxDepth)
        return "[depth limit]";
    if (Array.isArray(value)) {
        const len = Math.min(value.length, maxArrayItems);
        const result = new Array(len);
        for (let i = 0; i < len; i++) {
            result[i] = _boundedClone(value[i], maxArrayItems, maxStringLength, maxDepth, currentDepth + 1);
        }
        if (value.length > maxArrayItems) {
            result.push(`... (${value.length} items)`);
        }
        return result;
    }
    const result = {};
    for (const key of Object.keys(value)) {
        result[key] = _boundedClone(value[key], maxArrayItems, maxStringLength, maxDepth, currentDepth + 1);
    }
    return result;
}
/** Shared trace collector — one per request, passed through the tree. */
export class TraceCollector {
    traces = [];
    level;
    epoch = performance.now();
    /** Max array items to keep in bounded clone (configurable). */
    maxArrayItems;
    /** Max string length to keep in bounded clone (configurable). */
    maxStringLength;
    /** Max object depth to keep in bounded clone (configurable). */
    cloneDepth;
    constructor(level = "full", options) {
        this.level = level;
        this.maxArrayItems = options?.maxArrayItems ?? 100;
        this.maxStringLength = options?.maxStringLength ?? 1024;
        this.cloneDepth = options?.cloneDepth ?? 5;
    }
    /** Returns ms since the collector was created */
    now() {
        return roundMs(performance.now() - this.epoch);
    }
    record(trace) {
        this.traces.push(trace);
    }
    /** Build a trace entry, omitting input/output for basic level. */
    entry(base) {
        if (this.level === "basic") {
            const t = {
                tool: base.tool,
                fn: base.fn,
                durationMs: base.durationMs,
                startedAt: base.startedAt,
            };
            if (base.error)
                t.error = base.error;
            return t;
        }
        // full
        const t = {
            tool: base.tool,
            fn: base.fn,
            durationMs: base.durationMs,
            startedAt: base.startedAt,
        };
        if (base.input) {
            const clonedInput = boundedClone(base.input, this.maxArrayItems, this.maxStringLength, this.cloneDepth);
            if (clonedInput && typeof clonedInput === "object") {
                t.input = clonedInput;
            }
        }
        if (base.error)
            t.error = base.error;
        else if (base.output !== undefined)
            t.output = base.output;
        return t;
    }
}
