[![github](https://img.shields.io/badge/github-stackables/bridge-blue?logo=github)](https://github.com/stackables/bridge)

# The Bridge GraphQL adapter

The GraphQL adapter for [The Bridge](https://github.com/stackables/bridge) — takes your existing GraphQL schema and wires bridge logic into it. Your `.bridge` files become the resolvers. No boilerplate, no codegen.

# Installing

```bash
npm install @stackables/bridge-graphql @stackables/bridge-compiler graphql @graphql-tools/utils
```

`graphql` (≥ 16) and `@graphql-tools/utils` (≥ 11) are peer dependencies.

## Quick Start

```ts
import { bridgeTransform } from "@stackables/bridge-graphql";
import { parseBridge } from "@stackables/bridge-compiler";
import { createSchema, createYoga } from "graphql-yoga";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const typeDefs = readFileSync("schema.graphql", "utf8");
const bridgeSource = readFileSync("logic.bridge", "utf8");

// Parse the bridge file and wire it into the schema
const schema = bridgeTransform(
  createSchema({ typeDefs }),
  parseBridge(bridgeSource),
);

// That's it — start serving
const yoga = createYoga({ schema });
createServer(yoga).listen(4000, () => {
  console.log("http://localhost:4000/graphql");
});
```

## Tracing

Enable tool-call tracing to see exactly what the engine did during a request:

```ts
const schema = bridgeTransform(createSchema({ typeDefs }), instructions, {
  trace: "basic", // "off" | "basic" | "full"
  logger: console, // plug in pino, winston, or anything with debug/info/warn/error
});
```

## Part of the Bridge Ecosystem

| Package                                                                                    | What it does                                                        |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| [`@stackables/bridge`](https://www.npmjs.com/package/@stackables/bridge)                   | **The All-in-One** — everything in a single install                 |
| [`@stackables/bridge-compiler`](https://www.npmjs.com/package/@stackables/bridge-compiler) | **The Parser** — turns `.bridge` text into instructions             |
| [`@stackables/bridge-core`](https://www.npmjs.com/package/@stackables/bridge-core)         | **The Engine** — also supports standalone execution without GraphQL |
| [`@stackables/bridge-stdlib`](https://www.npmjs.com/package/@stackables/bridge-stdlib)     | **The Standard Library** — httpCall, strings, arrays, and more      |
| [`@stackables/bridge-types`](https://www.npmjs.com/package/@stackables/bridge-types)       | **Shared Types** — `ToolCallFn`, `ToolMap`, `CacheStore`            |
