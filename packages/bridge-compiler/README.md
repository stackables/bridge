[![github](https://img.shields.io/badge/github-stackables/bridge-blue?logo=github)](https://github.com/stackables/bridge)

# The Bridge Compiler

The parser for [The Bridge](https://github.com/stackables/bridge) — turns `.bridge` source files into executable instructions.

## Installing

```bash
npm install @stackables/bridge-compiler
```

## Parsing a Bridge File

The most common thing you'll do — read a `.bridge` file and get instructions the engine can run:

```ts
import { parseBridge } from "@stackables/bridge-compiler";
import { readFileSync } from "node:fs";

const source = readFileSync("logic.bridge", "utf8");
const instructions = parseBridge(source);

// → Instruction[] — feed this to executeBridge() or bridgeTransform()
```

## Serializing Back to `.bridge`

Round-trip support — parse a bridge file, then serialize the AST back into clean `.bridge` text:

```ts
import {
  parseBridgeFormat,
  serializeBridge,
} from "@stackables/bridge-compiler";

const ast = parseBridgeFormat(source);
const formatted = serializeBridge(ast);
```

## Part of the Bridge Ecosystem

| Package                                                                                  | What it does                                                   |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| [`@stackables/bridge`](https://www.npmjs.com/package/@stackables/bridge)                 | **The All-in-One** — everything in a single install            |
| [`@stackables/bridge-core`](https://www.npmjs.com/package/@stackables/bridge-core)       | **The Engine** — runs the instructions this package produces   |
| [`@stackables/bridge-graphql`](https://www.npmjs.com/package/@stackables/bridge-graphql) | **The Adapter** — wires bridges into a GraphQL schema          |
| [`@stackables/bridge-stdlib`](https://www.npmjs.com/package/@stackables/bridge-stdlib)   | **The Standard Library** — httpCall, strings, arrays, and more |
| [`@stackables/bridge-types`](https://www.npmjs.com/package/@stackables/bridge-types)     | **Shared Types** — `ToolCallFn`, `ToolMap`, `CacheStore`       |
