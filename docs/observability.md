# Bridge Observability — Tool-Call Tracing

Bridge ships with a built-in tracing system that records every tool invocation
during a GraphQL request. Traces are returned as a structured array in the
standard GraphQL `extensions` field, making them available to any client without
changing the data schema.

## Enabling Tracing

Pass `trace` when calling `bridgeTransform`:

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

## Response Format

When tracing is active, the GraphQL response includes an `extensions.traces`
array:

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

## What Gets Traced

The engine instruments **all** tool invocations:

- **Bridge-wired tools** — tools scheduled via `with <tool> as <alias>` in bridge blocks
- **Tool-def tools** — tools defined in `tool <name> from <fn> { … }` blocks (traced with both the tool name *and* the underlying `fn`)
- **Direct tool functions** — namespace tools like `std.upperCase`
- **Error paths** — when a tool throws, the trace captures the error message; if a `??` fallback or `on error` handler fires, the fallback tool gets its own trace entry

### Execution-Order Semantics

Traces appear in the order they **completed recording** (i.e. in the order the
engine invoked them). For sequential `||` chains, this means traces reflect the
left-to-right evaluation order, and short-circuited tools will be absent:

```
o.label <- primary.label || backup.label
```

If `primary` returns a non-null label, only one trace is recorded. If it
returns null, you'll see `primary` followed by `backup`.

## Programmatic Access

For non-Yoga setups (or middleware), you can read traces directly from the
GraphQL context:

```ts
import { getBridgeTraces } from "@stackables/bridge";

// Inside a resolver or middleware with access to context:
const traces = getBridgeTraces(context);
```

## Use in Tests

The test helper `createGateway` supports the `trace` option:

```ts
const gateway = createGateway(typeDefs, instructions, {
  tools: { geocoder: mockGeocoder },
  trace: true,
});
const executor = buildHTTPExecutor({ fetch: gateway.fetch });
const result = await executor({ document: parse(query) });

// Assertions on traces
const traces = result.extensions.traces;
assert.equal(traces.length, 1);
assert.equal(traces[0].tool, "geocoder");
assert.deepStrictEqual(traces[0].input, { q: "Berlin" });
```

This makes it easy to verify:
- **Which tools were called** and in what order
- **What inputs** the engine resolved for each tool
- **Whether fallbacks fired** (error traces + subsequent success traces)
- **Execution timing** for performance assertions

## TypeScript

The `ToolTrace` type is exported from the package:

```ts
import type { ToolTrace } from "@stackables/bridge";
```
