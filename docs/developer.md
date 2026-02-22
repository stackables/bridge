# Developer Guide — The Bridge Internals

This document explains the internal architecture of `@stackables/bridge` for contributors who want to understand how the pieces fit together.

---

## Overview

The Bridge is a declarative dataflow engine for GraphQL. Instead of resolvers, you write `.bridge` files that describe *what data is needed and where it comes from*. The engine reads those instructions and resolves fields on demand — only fetching what the client actually asked for.

The pipeline has two phases:

```
.bridge text  ──► [Lexer] ──► [Parser] ──► AST (Instruction[])
                                                     │
GraphQL request ──► [bridgeTransform] ──► [ExecutionTree] ──► response
```

---

## Source Map

```
packages/bridge/src/
├── index.ts              Public API — re-exports the stable surface
├── types.ts              All shared types (NodeRef, Wire, Bridge, ToolDef, …)
├── parser/
│   ├── index.ts          Thin entry point — exposes parseBridge + diagnostics API
│   ├── lexer.ts          Chevrotain tokens: keywords, operators, literals
│   └── parser.ts         Chevrotain CstParser + CST→AST visitor (toBridgeAst)
├── bridge-format.ts      Round-trip serializer: Instruction[] → .bridge text
├── bridge-transform.ts   GraphQL schema transformer — wraps field resolvers
├── ExecutionTree.ts      Pull-based execution engine (the core runtime)
├── utils.ts              parsePath helper ("a.b[0].c" → ["a","b","0","c"])
└── tools/
    ├── index.ts          builtinTools bundle + std namespace exports
    ├── http-call.ts      createHttpCall (REST API tool with LRU caching)
    ├── upper-case.ts     std.upperCase
    ├── lower-case.ts     std.lowerCase
    ├── find-object.ts    std.findObject (array search by predicate)
    ├── pick-first.ts     std.pickFirst (head of array, optional strict)
    └── to-array.ts       std.toArray (wrap scalar in array)
```

---

## The Parser Pipeline

### Lexer (`src/parser/lexer.ts`)

The lexer tokenizes `.bridge` source text using [Chevrotain](https://chevrotain.io). Key design points:

- Keywords (`tool`, `bridge`, `with`, `on`, …) are defined with `longer_alt: Identifier` so they don't conflict with user-defined names that start with the same characters
- Whitespace, newlines, and `#` comments are put on `Lexer.SKIPPED` — the parser never sees them
- Operator tokens (`<-!`, `<-`, `||`, `??`) are ordered from longest to shortest so Chevrotain matches the right one

```typescript
// Adding a new keyword — always set longer_alt to avoid stealing identifiers:
export const MyKw = createToken({ name: "MyKw", pattern: /my/i, longer_alt: Identifier });
```

### Parser (`src/parser/parser.ts`)

The parser is a Chevrotain `CstParser` (Concrete Syntax Tree). The grammar is defined as methods on the `BridgeParser` class (starts ~line 90). Each method corresponds to a grammar rule, using Chevrotain primitives (`this.CONSUME`, `this.SUBRULE`, `this.OPTION`, `this.MANY`, `this.OR`).

The parser produces a CST — a tree of named child arrays — which is intentionally untyped. The **visitor** (`toBridgeAst`, ~line 820) converts the CST into typed `Instruction[]` AST nodes.

Key grammar entry points:

| Rule | What it parses |
|---|---|
| `program` | Top-level — a sequence of version + blocks |
| `bridgeBlock` | A full `bridge Type.field { … }` block |
| `toolBlock` | A `tool name from fn { … }` block |
| `constBlock` | A `const name = value` declaration |
| `defineBlock` | A `define name { … }` reusable sub-graph |
| `bridgeWithDecl` | A `with X as Y` handle declaration |
| `wireDecl` | A wire line: `o.field <- source` or `o.field = "value"` |

### AST Types (`src/types.ts`)

The output of parsing is `Instruction[]`:

```typescript
type Instruction = Bridge | ToolDef | ConstDef | DefineDef;
```

The most important types are:

**`NodeRef`** — identifies a single data point in the execution graph:
```typescript
type NodeRef = {
  module: string;   // "myApi", "sendgrid", "_" (SELF_MODULE = bridge's own type)
  type: string;     // GraphQL type name or "Tools"
  field: string;    // field or function name
  instance?: number; // disambiguates multiple uses of the same tool in one bridge
  element?: boolean; // true when inside an array mapping block
  path: string[];   // drill-down: ["items", "0", "position", "lat"]
};
```

**`Wire`** — a directed data connection:
```typescript
type Wire =
  | { from: NodeRef; to: NodeRef; pipe?: true; force?: true; nullFallback?: string; fallback?: string; fallbackRef?: NodeRef }
  | { value: string; to: NodeRef };  // constant wire: value
```

**`Bridge`** — wires one GraphQL field to its data sources:
```typescript
type Bridge = {
  kind: "bridge";
  type: string;          // "Query" | "Mutation"
  field: string;         // GraphQL field name
  handles: HandleBinding[];  // declared sources (tools, input, output, context)
  wires: Wire[];
  arrayIterators?: Record<string, string>;  // for array mapping blocks
  pipeHandles?: Array<{ key: string; handle: string; baseTrunk: … }>;
  passthrough?: string;  // set when using shorthand: bridge Type.field with tool
};
```

---

## The Execution Engine (`src/ExecutionTree.ts`)

The engine is **pull-based**: resolution starts from a demanded GraphQL field and works backward through wire declarations to find its data sources.

### Entry point

`bridgeTransform` (in `bridge-transform.ts`) wraps every field resolver in the GraphQL schema. When a request arrives for a bridge-powered field, it creates an `ExecutionTree` for that field and calls `tree.pull(outputRefs)`.

### Core loop

`ExecutionTree.pullSingle(ref)` is the recursive heart of the engine:

1. Check the in-memory cache — if the trunk's result is already being computed, return the same `Promise` (deduplication)
2. Find all `Wire` entries whose `to` matches `ref` (by module/type/field/instance)
3. Group wires by their target path
4. For each group, resolve sources concurrently with `resolveWires`
5. Build the tool input object from all resolved values
6. Call the tool function (or return the constant value)
7. Cache the result, navigate the path into the result, return the value

### Cost-sorted resolution

When a bridge field has multiple sources (overdefinition, `||` null coalesce, `??` error coalesce), the engine sorts candidates by inferred cost:

- **Cost 0**: `input` arguments, `context`, `const` — already in memory
- **Cost 1**: tool calls — require a network or compute call

It evaluates cost-0 sources first. If they resolve, it short-circuits and never makes the expensive call. This is how you get field-level caching for free.

### Array mapping

When a field has `[] as iter { }` in the bridge, the engine detects the outer array wire, fetches the array, then creates a *shadow tree* for each element. The shadow tree inherits all non-element wires from its parent and resolves element-specific wires against the array element.

### TraceCollector

When `options.trace` is set to `"basic"` or `"full"`, each tool call is recorded by a `TraceCollector`. The full trace is retrievable via `useBridgeTracing(context)` inside a resolver. At `"full"` level, inputs and outputs are captured too.

---

## The Serializer (`src/bridge-format.ts`)

`formatBridge(instructions)` converts the AST back to `.bridge` text. This is used by developer tooling (auto-format, VS Code extension). The serializer:

1. Calls `buildHandleMap` to map canonical trunk keys back to human-readable handle names
2. Serializes each `Bridge` block with its `with` declarations and wire body
3. Converts `Wire` entries back to `<-`, `<-!`, `=` syntax
4. Handles pipe notation, array mapping blocks, fallback chains

---

## The GraphQL Transform (`src/bridge-transform.ts`)

`bridgeTransform(schema, instructions, options?)` uses `@graphql-tools/utils/mapSchema` to walk every field in the schema and wrap its resolver. The wrapper:

1. At the root field (no `path.prev`): checks if a `Bridge` instruction exists for this field. If not, falls through to the original resolver — hand-written resolvers coexist fine.
2. Creates an `ExecutionTree` with the active instructions, tools, and context
3. Calls `tree.pull(outputRefs)` — the engine does the rest
4. Returns the result as an `ExecutionTree` so nested fields can continue pulling from the same shared state

Child fields receive the parent `ExecutionTree` as their `source` and call `source.pull(ref)` to get their data.

---

## Adding a Built-in Tool

1. Create `src/tools/my-tool.ts`:

```typescript
export function myTool(input: Record<string, any>): Promise<Record<string, any>> {
  const { thing } = input;
  return Promise.resolve({ result: String(thing).toUpperCase() });
}
```

2. Export from `src/tools/index.ts` and add to the `std` object:

```typescript
export { myTool } from "./my-tool.js";

export const std = {
  upperCase,
  lowerCase,
  // ...
  myTool,
};
```

3. Add tests in `test/builtin-tools.test.ts`:

```typescript
test("std.myTool", async () => {
  const result = await execute(`
    version 1.4
    tool t from std.myTool
    bridge Query.result {
      with t
      with output as o
      o.value <- t.result
    }
  `, { tools: builtinTools });
  assert.equal(result.data.result.value, "HELLO");
});
```

4. Update the builtin tools example in `examples/builtin-tools/`.

---

## Testing Patterns

Tests use `node:test` and `node:assert`. No test framework needed.

### The `_gateway.ts` helper

`test/_gateway.ts` exports `createGateway({ bridgeText, typeDefs, tools?, options? })` which wires up a full graphql-yoga server. Tests call `execute(gql, variables?)` to query it.

```typescript
import { createGateway } from "./_gateway.js";

const { execute } = createGateway({
  typeDefs: `type Query { hello: String }`,
  bridgeText: `
    version 1.4
    bridge Query.hello {
      with const as c
      with output as o
      o._value = "world"
    }
  `,
});

test("hello returns world", async () => {
  const result = await execute("{ hello }");
  assert.equal(result.data?.hello, "world");
});
```

### Parser compatibility tests

`test/parser-compat.test.ts` uses snapshot-style `compat(description, bridgeText)` tests that parse the text and verify it round-trips through the serializer identically. Add one for every new syntax construct.

---

## The VS Code Extension (`packages/bridge-syntax-highlight`)

A separate package providing:
- TextMate grammar for `.bridge` files (syntax highlighting)
- Language configuration (bracket matching, comment toggling)
- A language server (hover, diagnostics via `parseBridgeDiagnostics`)

When you add a new keyword to the lexer, also update the grammar in `packages/bridge-syntax-highlight/syntaxes/bridge.tmLanguage.json`.

---

## Module System

Everything is ESM (`"type": "module"`). Import paths inside `src/` must use the `.js` extension (TypeScript convention for ESM — `.js` resolves to `.ts` during development via tsx, and to the compiled `.js` at runtime). Never use `.ts` extensions in imports.

---

## Release Process

Releases use `semantic-release` with conventional commits. Merging to `main` with a `feat:` or `fix:` commit triggers an automated release via GitHub Actions. Breaking changes need a `BREAKING CHANGE:` footer in the commit message to bump the major version.
