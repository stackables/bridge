---
title: Custom Tools
description: Writing custom tools
---

## Register Custom tools

You can inject your own tools into the engine. A tool is any function
`(input: object, context?: ToolContext) => object | Promise<object>`.

If you opt into native batching, the signature becomes
`(inputs: object[], context?: ToolContext) => object[] | Promise<object[]>`.

### Gateway Mode

```typescript
import { bridgeTransform, parseBridge } from "@stackables/bridge";

const document = parseBridge(bridgeText);

const schema = bridgeTransform(createSchema({ typeDefs }), document, {
  tools: {
    myCustomTool: (input) => ({ result: input.value * 2 }),
    geocoder: async (input) => await geocodeService.lookup(input.q),
  },
});
// std.str.toUpperCase, std.str.toLowerCase, httpCall, etc. are still available
```

### Standalone Mode

```typescript
import { executeBridge, parseBridge } from "@stackables/bridge";

const document = parseBridge(bridgeText);
const { data } = await executeBridge({
  document,
  operation: "Query.myField",
  input: { city: "Berlin" },
  tools: {
    myCustomTool: (input) => ({ result: input.value * 2 }),
  },
});
```

### Overriding `std` Tools

To replace a built-in tool, override the `std` namespace (shallow merge):

```typescript
import { bridgeTransform, std } from "@stackables/bridge";

const schema = bridgeTransform(createSchema({ typeDefs }), document, {
  tools: {
    std: { ...std, upperCase: myCustomUpperCase },
  },
});
```

## Authoring Tools

When writing the underlying TypeScript functions that power your `.bridge` tools, the engine automatically passes a second argument containing the `ToolContext`.

This context is vital for tying your custom TypeScript code into the engine's lifecycle and safety architecture.

```typescript
export interface ToolContext {
  logger?: Logger;
  signal?: AbortSignal;
}
```

For type-safe authoring, Bridge exports dedicated function types for both scalar and batched tools.

```typescript
import type {
  BatchToolFn,
  ScalarToolFn,
  ToolContext,
} from "@stackables/bridge";

const geocoder: ScalarToolFn<
  { q: string },
  { lat: number; lon: number }
> = async (input, context) => {
  context.logger?.debug?.({ q: input.q }, "geocoding");
  return await geocodeService.lookup(input.q, { signal: context.signal });
};

const fetchUsers: BatchToolFn<{ id: string }, { name: string }> = async (
  inputs,
  context,
) => {
  return await userService.fetchMany(inputs, { signal: context.signal });
};
```

### The `AbortSignal`

The Bridge engine uses a unified architecture for handling **Fatal Execution Halts**. Whether a client disconnects from the GraphQL server, or a developer writes a `panic` keyword in a `.bridge` file to intentionally kill the request, the engine triggers the `AbortSignal`.

To ensure your custom tools don't hang or waste resources during a fatal halt, **you must pass `context.signal` to any asynchronous drivers** (like `fetch` or database clients).

```typescript
// Example TypeScript Tool Implementation
export async function myHttpTool(input: { url: string }, context: ToolContext) {
  // Pass the signal down to native fetch!
  const response = await fetch(input.url, {
    signal: context.signal,
  });

  return await response.json();
}
```

By connecting the signal, the engine can instantly abort pending network requests the exact millisecond a failure state or client disconnect is detected, bypassing all local `?.` and `catch` fallbacks.

## Tool Metadata

You can attach a `.bridge` property to any tool function to control how the engine instruments it. Import `ToolMetadata` from `@stackables/bridge` for full type safety.

```typescript
import type { ToolMetadata } from "@stackables/bridge";

export async function geocoder(input: { q: string }) {
  return await geocodeService.lookup(input.q);
}

geocoder.bridge = {
  trace: true, // emit an OTel span (default: true)
  log: {
    // log successful calls at info level (default false)
    execution: "info",
    // log failures at error level (default error)
    errors: "error",
  },
} satisfies ToolMetadata;
```

## Native Batching

If your backend already supports bulk fetches, you can let Bridge batch loop-scoped tool calls for you. This removes the need to thread DataLoaders through GraphQL context just to avoid N+1 calls.

### Batch Authoring Contract

Mark the tool with `bridge.batch`, then implement it as `Input[] -> Output[]`.

```typescript
import type { BatchToolFn, ToolMetadata } from "@stackables/bridge";

export const fetchUsers: BatchToolFn<{ id: string }, { name: string }> = async (
  inputs,
  context,
) => {
  const rows = await userService.fetchManyById(
    inputs.map((input) => input.id),
    { signal: context.signal },
  );

  return inputs.map((input) => ({
    name: rows.get(input.id)?.name ?? "unknown",
  }));
};

fetchUsers.bridge = {
  batch: {
    maxBatchSize: 100,
    flush: "microtask",
  },
} satisfies ToolMetadata;
```

Rules:

- A batched tool always receives a plain array of input objects.
- A batched tool must return an array with the same length and ordering.
- Bridge fans the results back out to the original wire sites automatically.
- `maxBatchSize` splits very large queues into multiple batch calls.
- `flush: "microtask"` means compatible calls in the same microtask are coalesced together.
- Native batching works in both the runtime interpreter and the compiled executor.

### Tracing and Logging

Batch tools are instrumented once per flushed batch call, not once per item.

- One OpenTelemetry span is emitted for each actual batch function call.
- One trace entry is recorded for each actual batch function call.
- One success or error log is emitted for each actual batch function call.
- In `trace: "full"`, the trace input/output are arrays.
