# Bridge Observability — Traces, Metrics, and Logs

Bridge ships with first-class observability built on three pillars:

1. **OpenTelemetry spans** — every tool call produces a `bridge.tool` span via
   the standard `@opentelemetry/api`. Zero-overhead no-ops when no OTel SDK is
   registered.
2. **OpenTelemetry metrics** — counters and duration histograms for every tool
   call, also via `@opentelemetry/api`.
3. **Structured logging** — a pluggable `Logger` interface routes engine-level
   events (completions, errors, warnings) to any compatible logger.
4. **`extensions.traces`** — structured per-request traces returned in the
   GraphQL `extensions` field for debugging and testing (opt-in).

---

## OpenTelemetry Integration

Bridge instruments every tool invocation using the standard
[`@opentelemetry/api`](https://www.npmjs.com/package/@opentelemetry/api)
package. No additional configuration is required inside Bridge itself — you only
need to register an OTel SDK in your application.

### Spans

Each tool call produces one span named **`bridge.tool`** with these attributes:

| Attribute | Value |
|-----------|-------|
| `bridge.tool.name` | Tool name as resolved by the engine (e.g. `"geocoder"`, `"std.upperCase"`) |
| `bridge.tool.fn` | Registered function that was called (e.g. `"httpCall"`, `"upperCase"`) |

On error the span status is set to `ERROR` and the exception is recorded with
`span.recordException()`.

### Metrics

The following instruments are registered under the `@stackables/bridge` meter:

| Metric | Type | Unit | Description |
|--------|------|------|-------------|
| `bridge.tool.calls` | Counter | — | Total number of tool invocations (success + error) |
| `bridge.tool.duration` | Histogram | ms | Tool call wall-clock duration in milliseconds |
| `bridge.tool.errors` | Counter | — | Total number of tool invocations that threw |

All instruments carry the same `bridge.tool.name` and `bridge.tool.fn`
attribute set as spans, so they can be filtered and grouped the same way.

### Example SDK Setup (Node.js)

```ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter(),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter(),
  }),
});
sdk.start();
```

Once the SDK is running, every `bridge.tool` span and metric is automatically
exported to your configured backend (Jaeger, Zipkin, Grafana Tempo/Mimir, etc.).
No changes to Bridge configuration are needed.

---

## Structured Logging

Pass any logger that implements the four-method `Logger` interface:

```ts
import { bridgeTransform } from "@stackables/bridge";
import type { Logger } from "@stackables/bridge";

const schema = bridgeTransform(baseSchema, instructions, {
  tools,
  logger: console,           // console works out of the box
  // logger: pinoInstance,   // pino, winston, bunyan — any compatible logger
});
```

### `Logger` Interface

```ts
interface Logger {
  debug: (...args: any[]) => void;
  info:  (...args: any[]) => void;
  warn:  (...args: any[]) => void;
  error: (...args: any[]) => void;
}
```

When `logger` is omitted (default), all methods are silent no-ops — zero output
and zero overhead.

### What Gets Logged

| Level | Event |
|-------|-------|
| `debug` | Successful tool completion: tool name, fn, duration |
| `error` | Tool invocation failure: tool name, fn, error message |
| `warn` | Engine-level warnings (e.g. accessing a field on an array without `pickFirst`) |

---

## Enabling `extensions.traces`

Pass `trace` to also populate the GraphQL response `extensions.traces` array
(useful for debugging and per-request visibility in tests or developer tooling):

```ts
import { bridgeTransform, useBridgeTracing } from "@stackables/bridge";

const schema = bridgeTransform(baseSchema, instructions, {
  tools,
  trace: true,      // "full" — records tool, fn, input, output, timing
  // trace: "basic", // records tool, fn, timing, error (no input/output)
});
```

Then register the companion Yoga plugin so traces are surfaced in the response:

```ts
import { createYoga } from "graphql-yoga";

const yoga = createYoga({
  schema,
  plugins: [useBridgeTracing()],
});
```

> **Zero overhead when disabled** — when `trace` is omitted or `false`, no
> collector is created and the hot path is not touched.
>
> OTel spans and metrics are emitted regardless of the `trace` option; they
> become no-ops automatically when no OTel SDK is registered.

### Response Format

When `extensions.traces` is active, the GraphQL response includes:

```json
{
  "data": { "lookup": { "label": "Berlin, DE" } },
  "extensions": {
    "traces": [
      {
        "tool": "geocoder",
        "fn": "httpCall",
        "input": { "q": "Berlin", "baseUrl": "https://api.example.com", "method": "GET", "path": "/geocode" },
        "output": { "label": "Berlin, DE" },
        "durationMs": 42.5,
        "startedAt": 0.12
      }
    ]
  }
}
```

### Trace Levels

| Value | Records |
|-------|---------|
| `true` / `"full"` | tool, fn, input, output, error, timing |
| `"basic"` | tool, fn, error, timing (no input/output — lighter payload) |
| `false` (default) | nothing — zero overhead |

### `ToolTrace` Fields

| Field | Type | Description |
|-------|------|-------------|
| `tool` | `string` | Tool name as resolved by the engine (e.g. `"geocoder"`, `"std.upperCase"`) |
| `fn` | `string` | The registered function that was called (e.g. `"httpCall"`, `"upperCase"`) |
| `input` | `object` | Input object passed to the tool function, after all wire resolution (`"full"` only) |
| `output` | `any` | Return value of the tool — present on success (`"full"` only) |
| `error` | `string` | Error message (present when the tool threw) |
| `durationMs` | `number` | Wall-clock execution time in milliseconds |
| `startedAt` | `number` | Timestamp (ms) relative to the first trace in the request |

> A trace always has either `output` or `error`, never both.

---

## What Gets Observed

The engine instruments **all** tool invocations via all three pillars:

- **Bridge-wired tools** — tools scheduled via `with <tool> as <alias>` in bridge blocks
- **Tool-def tools** — tools defined in `tool <name> from <fn> { … }` blocks (traced with both the tool name *and* the underlying `fn`)
- **Direct tool functions** — namespace tools like `std.upperCase`
- **Error paths** — when a tool throws, the span is marked ERROR, the error counter increments, and `logger.error` fires; if a `??` fallback or `on error` handler fires, the fallback tool gets its own instrumentation

### Execution-Order Semantics (traces)

`extensions.traces` entries appear in completion order. For sequential `||`
chains, short-circuited tools will be absent:

```
o.label <- primary.label || backup.label
```

If `primary` returns a non-null label, only one trace is recorded.

---

## Combining All Three

```ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { bridgeTransform, useBridgeTracing } from "@stackables/bridge";
import pino from "pino";

// 1. Start OTel SDK (spans + metrics → your backend)
new NodeSDK({
  traceExporter: new OTLPTraceExporter(),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter(),
  }),
}).start();

// 2. Configure Bridge with logger + trace
const schema = bridgeTransform(baseSchema, instructions, {
  tools,
  logger: pino(),           // structured log output
  trace: "basic",           // lightweight per-request traces in extensions
});

// 3. Register Yoga plugin for extensions.traces
const yoga = createYoga({ schema, plugins: [useBridgeTracing()] });
```

---

## Programmatic Access

For non-Yoga setups (or middleware), read traces directly from the GraphQL context:

```ts
import { getBridgeTraces } from "@stackables/bridge";

const traces = getBridgeTraces(context);
```

---

## Use in Tests

The test helper `createGateway` supports the `trace` option:

```ts
const gateway = createGateway(typeDefs, instructions, {
  tools: { geocoder: mockGeocoder },
  trace: true,
});
const executor = buildHTTPExecutor({ fetch: gateway.fetch });
const result = await executor({ document: parse(query) });

const traces = result.extensions.traces;
assert.equal(traces.length, 1);
assert.equal(traces[0].tool, "geocoder");
assert.deepStrictEqual(traces[0].input, { q: "Berlin" });
```

---

## TypeScript

All observability types are exported from the package:

```ts
import type { Logger, ToolTrace, TraceLevel } from "@stackables/bridge";
```
