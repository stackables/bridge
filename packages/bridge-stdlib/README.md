[![github](https://img.shields.io/badge/github-stackables/bridge-blue?logo=github)](https://github.com/stackables/bridge)

# The Bridge standard library

The standard library for [The Bridge](https://github.com/stackables/bridge) — a collection of built-in tools: HTTP calls, string manipulation, array operations, audit logging, and input validation.

You usually won't install this directly. It comes bundled with both [`@stackables/bridge`](https://www.npmjs.com/package/@stackables/bridge) and [`@stackables/bridge-core`](https://www.npmjs.com/package/@stackables/bridge-core).

# Installing

You might need to install this separately if you want to use different versions of standard library in your `.bridge` files or customise the http client cache handling.

```bash
npm install @stackables/bridge-stdlib
```

## Customizing httpCall

The default `httpCall` uses `globalThis.fetch` and an in-memory LRU cache. If you need to swap in a custom fetch or plug in Redis for caching:

```ts
import { createHttpCall } from "@stackables/bridge-stdlib";

// Use a custom fetch and a Redis-backed cache store
const httpCall = createHttpCall(myCustomFetch, myRedisCacheStore);
```

Then pass it to the engine via the `tools` option.

## Part of the Bridge Ecosystem

| Package                                                                                    | What it does                                             |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| [`@stackables/bridge`](https://www.npmjs.com/package/@stackables/bridge)                   | **The All-in-One** — everything in a single install      |
| [`@stackables/bridge-core`](https://www.npmjs.com/package/@stackables/bridge-core)         | **The Engine** — runs pre-compiled bridge instructions   |
| [`@stackables/bridge-parser`](https://www.npmjs.com/package/@stackables/bridge-parser)     | **The Parser** — turns `.bridge` text into instructions  |
| [`@stackables/bridge-compiler`](https://www.npmjs.com/package/@stackables/bridge-compiler) | **The Compiler** — compiles BridgeDocument into optimized JavaScript |
| [`@stackables/bridge-graphql`](https://www.npmjs.com/package/@stackables/bridge-graphql)   | **The Adapter** — wires bridges into a GraphQL schema    |
| [`@stackables/bridge-types`](https://www.npmjs.com/package/@stackables/bridge-types)       | **Shared Types** — `ToolCallFn`, `ToolMap`, `CacheStore` |
