---
title: Custom Tools
description: Writing custom tools
---

## Register Custom tools

You can inject your own tools into the engine. A tool is any function
`(input: object) => object | Promise<object>`.

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
