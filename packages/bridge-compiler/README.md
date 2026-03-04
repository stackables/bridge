[![github](https://img.shields.io/badge/github-stackables/bridge-blue?logo=github)](https://github.com/stackables/bridge)

# The Bridge Compiler

> **🧪 Experimental:** This package is currently in Beta. It passes all core test suites, but some edge-case Bridge language features may behave differently than the standard `bridge-core` interpreter. Use with caution in production.

The high-performance, native JavaScript execution engine for [The Bridge](https://github.com/stackables/bridge).

While the standard `@stackables/bridge-core` package evaluates Bridge ASTs dynamically at runtime (an Interpreter), this package acts as a **Just-In-Time (JIT) / Ahead-of-Time (AOT) Compiler**. It takes a parsed Bridge AST, topologically sorts the dependencies, and generates a raw V8-optimized JavaScript function.

The result? **Zero-allocation array loops, native JS math operators, and maximum throughput (RPS)** that runs neck-and-neck with hand-coded Node.js.

## Installing

```bash
npm install @stackables/bridge-compiler

```

## When to Use This

Use the Compiler when you need maximum performance in a Node.js, Bun, or standard Deno environment. It is designed for the **Compile-Once, Run-Many** workflow.

On the very first request, the engine compiles the operation into native JavaScript and caches the resulting function in memory. Subsequent requests bypass the AST entirely and execute bare-metal JS.

### The Drop-In Replacement

Because the API perfectly mirrors the standard engine, upgrading your production server to compiled code requires changing only a single line of code:

```diff
- import { executeBridge } from "@stackables/bridge-core";
+ import { executeBridge } from "@stackables/bridge-compiler";

```

### Example Usage

```ts
import { parseBridge } from "@stackables/bridge-parser";
import { executeBridge } from "@stackables/bridge-compiler";
import { readFileSync } from "fs";

// 1. Parse your schema into an AST once at server startup
const document = parseBridge(readFileSync("endpoints.bridge", "utf8"));

// 2. Execute (Compiles to JS on the first run, uses cached function thereafter)
const { data } = await executeBridge({
  document,
  operation: "Query.searchTrains",
  input: { from: "Bern", to: "Zürich" },
  tools: {
    fetchSimple: async (args) => fetch(...),
  }
});

console.log(data);

```

### Advanced: Extracting the Source Code

If you want to build a CLI that outputs physical `.js` files to disk (True AOT), you can use the underlying generator directly:

```ts
import { compileBridge } from "@stackables/bridge-compiler";

const { code, functionName } = compileBridge(document, {
  operation: "Query.searchTrains",
});

console.log(code); // Prints the raw `export default async function...` string
```

## API: `ExecuteBridgeOptions`

| Option             | Type                  | What it does                                                                     |
| ------------------ | --------------------- | -------------------------------------------------------------------------------- |
| `document`         | `BridgeDocument`      | The parsed AST from `@stackables/bridge-parser`.                                 |
| `operation`        | `string`              | Which bridge to run, e.g. `"Query.myField"`.                                     |
| `input?`           | `Record<string, any>` | Input arguments — equivalent to GraphQL field args.                              |
| `tools?`           | `ToolMap`             | Your custom tool functions (merged with built-in `std`).                         |
| `context?`         | `Record<string, any>` | Shared data available via `with context as ctx` in `.bridge` files.              |
| `signal?`          | `AbortSignal`         | Pass an `AbortSignal` to cancel execution and upstream HTTP requests mid-flight. |
| `toolTimeoutMs?`   | `number`              | Fails the execution if a single tool takes longer than this threshold.           |
| `logger?`          | `Logger`              | Structured logger for tool calls.                                                |
| `requestedFields?` | `string[]`            | Sparse fieldset filter — only resolve the listed output fields. Supports dot-separated paths and a trailing `*` wildcard (e.g. `["id", "legs.*"]`). Omit to resolve all fields. |

_Returns:_ `Promise<{ data: T }>`

## ⚠️ Runtime Compatibility (Edge vs Node)

Because this package dynamically evaluates generated strings into executable code (`new AsyncFunction(...)`), it requires a runtime that permits dynamic code evaluation.

- ✅ **Fully Supported:** Node.js, Bun, Deno, AWS Lambda, standard Docker containers.
- ❌ **Not Supported:** Cloudflare Workers, Vercel Edge, Deno Deploy (Strict V8 Isolates block code generation from strings for security reasons).

If you are deploying to an Edge runtime, use the standard interpreter (`executeBridge` from `@stackables/bridge-core`) instead, which executes the AST dynamically without string evaluation.

## Part of the Bridge Ecosystem

| Package                                                                                    | What it does                                                                 |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| [`@stackables/bridge`](https://www.npmjs.com/package/@stackables/bridge)                   | **The All-in-One** — everything in a single install                          |
| [`@stackables/bridge-parser`](https://www.npmjs.com/package/@stackables/bridge-parser)     | **The Parser** — turns `.bridge` text into the instructions this engine runs |
| [`@stackables/bridge-compiler`](https://www.npmjs.com/package/@stackables/bridge-compiler) | **The Compiler** — compiles BridgeDocument into optimized JavaScript         |
| [`@stackables/bridge-graphql`](https://www.npmjs.com/package/@stackables/bridge-graphql)   | **The Adapter** — wires bridges into a GraphQL schema                        |
| [`@stackables/bridge-stdlib`](https://www.npmjs.com/package/@stackables/bridge-stdlib)     | **The Standard Library** — httpCall, strings, arrays, and more               |
| [`@stackables/bridge-types`](https://www.npmjs.com/package/@stackables/bridge-types)       | **Shared Types** — `ToolCallFn`, `ToolMap`, `CacheStore`                     |
