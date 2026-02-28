## Modular Package Strategy & AOT Ergonomics

**Status:** Planned
**Target Release:** v2.0 (Architecture Finalization)

### 📖 The Problem: Everything Ships Together

Today the entire Bridge lives in one package (`@stackables/bridge`, ~10k LoC). Every consumer — a full GraphQL server, an Edge worker running a single bridge, the VS Code extension, the playground — pulls the same bundle containing Chevrotain, graphql-js, @graphql-tools/utils, @opentelemetry/api, and lru-cache.

The dependency graph already has clean internal boundaries:

| File(s)                                                                             | External deps                     |
| ----------------------------------------------------------------------------------- | --------------------------------- |
| `parser/lexer.ts`, `parser/parser.ts`                                               | `chevrotain`                      |
| `bridge-transform.ts`                                                               | `graphql`, `@graphql-tools/utils` |
| `ExecutionTree.ts`                                                                  | `@opentelemetry/api`              |
| `tools/http-call.ts`                                                                | `lru-cache`                       |
| `execute-bridge.ts`, `language-service.ts`, `bridge-lint.ts`, `types.ts`, `tools/*` | none (internal only)              |

These boundaries mean the split is already implied by the code — it just isn't formalised in the package structure yet.

### Why it matters

1. **Edge / serverless cold-start.** A Cloudflare Worker that runs pre-compiled bridges via `executeBridge()` should not bundle Chevrotain or graphql-js. Today it must.
2. **VS Code extension size.** The language server only needs the parser and `BridgeLanguageService`. It currently esbuild-bundles the entire package (868 KB server.js).
3. **Peer-dep flexibility.** GraphQL servers should declare `graphql` as a peer dependency, not force a specific version.
4. **AOT deployment.** Compiling `.bridge` → JSON at build time and shipping only the runtime is a natural workflow, but today there is no clean package boundary between "parse" and "run".

### 📦 Proposed Package Split

**`@stackables/bridge-core` — The Runtime**

- `ExecutionTree`, cost scheduler, `ToolContext`, `std` + `math` tools, `executeBridge()`
- Dependencies: `@opentelemetry/api` (optional peer), `lru-cache` (for httpCall cache)
- Input: `BridgeDocument` (pre-parsed JSON AST)
- Use case: Edge workers, CLI tools, background jobs, any non-GraphQL consumer

**`@stackables/bridge-compiler` — The Parser**

- Chevrotain lexer, parser, AST visitor, serializer (`bridge-format.ts`)
- Dependencies: `chevrotain`
- Input/Output: `.bridge` text → `BridgeDocument`
- Also exports: `parseBridgeDiagnostics`, `BridgeLanguageService` (diagnostics, completions, hover)

**`@stackables/bridge-graphql` — The GraphQL Adapter**

- `bridgeTransform()`, tracing helpers (`useBridgeTracing`, `getBridgeTraces`)
- Peer dependencies: `graphql`, `@graphql-tools/utils`, `@stackables/bridge-core`
- Use case: Apollo, Yoga, or any GraphQL server

**`@stackables/bridge` — The Meta-Package (Optional Convenience)**

- Re-exports everything from core + compiler + graphql
- For developers who want one import and don't care about bundle size
- Equivalent to today's single package

**`@stackables/bridge-cli` — Dev Tools**

- `bridge lint` (replaces current `bridge-lint` bin)
- `bridge build` — compile `.bridge` files to `.bridge.json` for AOT deployment
- Dependencies: compiler (dev-time only)

### 🧑‍💻 Developer Workflows

**Workflow A: Full GraphQL Server (JIT, current default)**

```
npm install @stackables/bridge-graphql @stackables/bridge-compiler graphql
```

Parse `.bridge` files at startup, wire into the schema via `bridgeTransform()`. Same as today.

**Workflow B: Standalone Edge API (AOT)**

```
# CI build step
npx @stackables/bridge-cli build src/*.bridge -o routes.json

# Production — only the runtime, no parser, no graphql
npm install @stackables/bridge-core
```

```ts
import { executeBridge } from "@stackables/bridge-core";
import document from "./routes.json" assert { type: "json" };

const { data } = await executeBridge({
  document,
  operation: "Query.search",
  input: { q: req.query.q },
});
```

**Workflow C: VS Code Extension / Playground**

```
npm install @stackables/bridge-compiler
```

Only the parser and `BridgeLanguageService` — no runtime, no GraphQL.

### 🛠️ Implementation Plan

The monorepo (`pnpm-workspace.yaml`) is already in place. The split is mechanical:

1. **Extract shared types.** `types.ts` and `utils.ts` move to `bridge-core`. Both compiler and GraphQL adapter import from core.

2. **Extract the parser.** `parser/`, `bridge-format.ts`, `language-service.ts` become `bridge-compiler`. Its only external dep is `chevrotain`.

3. **Extract the GraphQL adapter.** `bridge-transform.ts` becomes `bridge-graphql`. Peer-depends on `graphql`, `@graphql-tools/utils`, and `bridge-core`.

4. **Core keeps the engine.** `ExecutionTree.ts`, `execute-bridge.ts`, `tools/` stay in `bridge-core`.

5. **Subpath exports first.** Before splitting into separate npm packages, expose the boundaries via `package.json` `"exports"` subpaths (`@stackables/bridge/core`, `@stackables/bridge/compiler`, `@stackables/bridge/graphql`). This lets consumers opt in incrementally without a breaking change.

6. **Wire up the CLI.** Connect `bridge-lint.ts` and a new `bridge build` command to a proper CLI entry point in `bridge-cli`.

### ⚠️ Migration Path

The convenience meta-package (`@stackables/bridge`) continues to re-export everything, so existing `import { bridgeTransform, parseBridge } from "@stackables/bridge"` code keeps working. The split is opt-in for consumers who want smaller bundles.
