[![github](https://img.shields.io/badge/github-stackables/bridge-blue?logo=github)](https://github.com/stackables/bridge)

# The Bridge Runtime

The lightweight runtime engine for [The Bridge](https://github.com/stackables/bridge).

This is **The Engine** — it takes pre-compiled bridge instructions (a JSON AST) and executes them. No parser, no GraphQL, no heavy dependencies. If you're deploying to a Cloudflare Worker, a Vercel Edge function, or any environment where bundle size matters, this is the package you want in production.

## Installing

```bash
npm install @stackables/bridge-core
```

## When to Use This

The most common pattern is the **Ahead-of-Time (AOT) workflow**: compile your `.bridge` files to JSON during CI/CD, then ship only the instructions + this engine to production. The parser and its dependencies never touch your production bundle.

```ts
import { executeBridge } from "@stackables/bridge-core";
import instructions from "./compiled-bridge.json" assert { type: "json" };

const { data } = await executeBridge({
  instructions,
  operation: "Query.searchTrains",
  input: { from: "Bern", to: "Zürich" },
});

console.log(data);
```

## Options

| Option         | What it does                                             |
| -------------- | -------------------------------------------------------- |
| `instructions` | Pre-compiled bridge instructions (from the compiler)     |
| `operation`    | Which bridge to run, e.g. `"Query.myField"`              |
| `input`        | Input arguments — like GraphQL field args                |
| `tools`        | Your custom tool functions (merged with built-in `std`)  |
| `context`      | Shared data available via `with context` in bridge files |
| `trace`        | Tool-call tracing: `"off"`, `"basic"`, or `"full"`       |
| `logger`       | Plug in pino, winston, console — whatever you use        |
| `signal`       | Pass an `AbortSignal` to cancel execution mid-flight     |

Returns `{ data, traces }`.

## Part of the Bridge Ecosystem

| Package                                                                                    | What it does                                                                 |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| [`@stackables/bridge`](https://www.npmjs.com/package/@stackables/bridge)                   | **The All-in-One** — everything in a single install                          |
| [`@stackables/bridge-compiler`](https://www.npmjs.com/package/@stackables/bridge-compiler) | **The Parser** — turns `.bridge` text into the instructions this engine runs |
| [`@stackables/bridge-graphql`](https://www.npmjs.com/package/@stackables/bridge-graphql)   | **The Adapter** — wires bridges into a GraphQL schema                        |
| [`@stackables/bridge-stdlib`](https://www.npmjs.com/package/@stackables/bridge-stdlib)     | **The Standard Library** — httpCall, strings, arrays, and more               |
| [`@stackables/bridge-types`](https://www.npmjs.com/package/@stackables/bridge-types)       | **Shared Types** — `ToolCallFn`, `ToolMap`, `CacheStore`                     |
