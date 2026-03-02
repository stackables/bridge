/**
 * Tracing and OpenTelemetry instrumentation for the execution engine.
 *
 * Extracted from ExecutionTree.ts — Phase 1 of the refactor.
 * See docs/execution-tree-refactor.md
 */
export declare const otelTracer: import("@opentelemetry/api").Tracer;
export declare function isOtelActive(): boolean;
export declare const toolCallCounter: import("@opentelemetry/api").Counter<import("@opentelemetry/api").Attributes>;
export declare const toolDurationHistogram: import("@opentelemetry/api").Histogram<import("@opentelemetry/api").Attributes>;
export declare const toolErrorCounter: import("@opentelemetry/api").Counter<import("@opentelemetry/api").Attributes>;
export { SpanStatusCode as SpanStatusCodeEnum } from "@opentelemetry/api";
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
/**
 * Bounded clone utility — replaces `structuredClone` for trace data.
 * Truncates arrays, strings, and deep objects to prevent OOM when
 * tracing large payloads.
 */
export declare function boundedClone(value: unknown, maxArrayItems?: number, maxStringLength?: number, depth?: number): unknown;
/** Shared trace collector — one per request, passed through the tree. */
export declare class TraceCollector {
    readonly traces: ToolTrace[];
    readonly level: "basic" | "full";
    private readonly epoch;
    /** Max array items to keep in bounded clone (configurable). */
    readonly maxArrayItems: number;
    /** Max string length to keep in bounded clone (configurable). */
    readonly maxStringLength: number;
    /** Max object depth to keep in bounded clone (configurable). */
    readonly cloneDepth: number;
    constructor(level?: "basic" | "full", options?: {
        maxArrayItems?: number;
        maxStringLength?: number;
        cloneDepth?: number;
    });
    /** Returns ms since the collector was created */
    now(): number;
    record(trace: ToolTrace): void;
    /** Build a trace entry, omitting input/output for basic level. */
    entry(base: {
        tool: string;
        fn: string;
        startedAt: number;
        durationMs: number;
        input?: Record<string, any>;
        output?: any;
        error?: string;
    }): ToolTrace;
}
//# sourceMappingURL=tracing.d.ts.map