# AGENTS.md — Coding Agent Instructions

> This document is for AI coding agents working on The Bridge codebase.
> Read this first before making any changes.

---

## What is The Bridge?

A declarative dataflow language (`.bridge` files) and pull-based execution engine for API orchestration. Instead of writing imperative resolver code, developers describe **what** data they need and **where** it comes from. The engine builds a dependency graph and executes it automatically — handling parallelization, fallback chains, and data reshaping.

The project is a **pnpm monorepo** with multiple packages under `packages/` and runnable examples under `examples/`.

---

## Prerequisites

- **Node.js ≥ 24** (the test runner uses `node:test`)
- **pnpm ≥ 10**

```bash
pnpm install     # install all workspace dependencies
pnpm build       # build all packages
pnpm test        # run all unit tests
pnpm e2e         # run all end-to-end tests
```

---

## Mandatory Workflow

### 1. Tests must always pass

There are **zero** pre-existing test failures. Before starting any work, confirm the baseline:

```bash
pnpm test        # all unit tests must pass
pnpm e2e         # all e2e tests must pass
```

If you find failing tests before your changes, **fix them first** — do not proceed with new work on a broken baseline.

### 2. Test-first for bug fixes

When fixing a bug, **write a failing test first** that reproduces the bug, then implement the fix. The test proves the bug existed and prevents regression.

### 3. Tests for new features

Every new feature, syntax addition, or behavioral change needs test coverage. Match the test file to the area you're changing (see test index below).

### 4. Changesets

Every **user-facing** change requires a changeset. After making changes, create one:

```bash
pnpm changeset
```

This will interactively prompt you to:

1. Select which packages changed (use space to select, enter to confirm)
2. Choose the semver bump type (patch / minor / major)
3. Write a brief summary of the change

The changeset file is committed with your code. The CI pipeline uses it to version and publish.

**Do NOT create a changeset for non-user-facing changes.** These don't trigger a package release. Examples of changes that do **not** need a changeset:

- Adding or updating tests
- Updating READMEs, documentation, or comments
- CI/tooling configuration changes
- Changes to `AGENTS.md`, `CONTRIBUTING.md`, or similar repo-level docs

### 5. Build verification

After any code change, verify the build is clean:

```bash
pnpm build       # must complete with 0 errors
```

TypeScript is strict — `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch` are all enabled.

### 6. Syntax highlighting and SDL

For every language change, review and adjust the playground and vscode extension functionality. Especially syntax highlighting and autocomplete

---

## Package Architecture

```
packages/
  bridge-types/          Shared type definitions (ToolContext, ToolCallFn, ToolMap, CacheStore)
  bridge-compiler/       Parser (Chevrotain), serializer, linter, language service
  bridge-core/           Execution engine (ExecutionTree), type definitions (Wire, Bridge, NodeRef)
  bridge-stdlib/         Standard library tools (httpCall, strings, arrays, audit, assert)
  bridge-graphql/        GraphQL schema adapter (bridgeTransform)
  bridge/                Umbrella package — re-exports everything as @stackables/bridge
  bridge-syntax-highlight/  VS Code extension (TextMate grammar, language server)
  docs-site/             Documentation website (Astro + Starlight)
  playground/            Browser playground (Vite + React)
```

### Dependency graph (no cycles)

```
bridge-types          ← shared types, no dependencies
    ↑
bridge-stdlib         ← depends on bridge-types
    ↑
bridge-core           ← depends on bridge-types + bridge-stdlib
    ↑
bridge-compiler       ← depends on bridge-core (for type imports)
    ↑
bridge-graphql        ← depends on bridge-core + bridge-compiler
    ↑
bridge                ← umbrella, re-exports all of the above
```

### Key source files

| File                                      | What it does                                                           |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| `bridge-compiler/src/parser/lexer.ts`     | Chevrotain token definitions (keywords, operators)                     |
| `bridge-compiler/src/parser/parser.ts`    | Grammar rules (`BridgeParser` class) + CST→AST visitor (`toBridgeAst`) |
| `bridge-compiler/src/bridge-format.ts`    | AST → `.bridge` text serializer                                        |
| `bridge-compiler/src/bridge-lint.ts`      | Linter rules                                                           |
| `bridge-compiler/src/language-service.ts` | Hover info, diagnostics for IDE integration                            |
| `bridge-core/src/types.ts`                | Core types: `Wire`, `Bridge`, `NodeRef`, `Instruction`, `ToolDef`      |
| `bridge-core/src/ExecutionTree.ts`        | Pull-based execution engine (the runtime core)                         |
| `bridge-core/src/execute-bridge.ts`       | Standalone (non-GraphQL) bridge execution entry point                  |
| `bridge-core/src/tools/internal.ts`       | Engine-internal tools (math ops, concat, comparisons)                  |
| `bridge-stdlib/src/tools/http-call.ts`    | `httpCall` REST client with LRU caching                                |
| `bridge-stdlib/src/tools/strings.ts`      | String tools (upper, lower, slice, pad, etc.)                          |
| `bridge-stdlib/src/tools/arrays.ts`       | Array tools (find, first, toArray, flat, sort, etc.)                   |
| `bridge-stdlib/src/tools/audit.ts`        | Audit logging tool                                                     |
| `bridge-stdlib/src/tools/assert.ts`       | Input assertion tool                                                   |
| `bridge-graphql/src/bridge-transform.ts`  | Wraps GraphQL field resolvers with bridge execution                    |

---

## Test Index

Tests live in `packages/bridge/test/`. They use `node:test` and `node:assert` — no Jest or Vitest.

**Run a single test file:**

```bash
cd packages/bridge
node --experimental-transform-types --conditions source --test test/<filename>.test.ts
```

| Test file                         | What it covers                                 | When to add tests here          |
| --------------------------------- | ---------------------------------------------- | ------------------------------- |
| `parser-compat.test.ts`           | Parse → serialize round-trips (snapshot-style) | New syntax, grammar changes     |
| `bridge-format.test.ts`           | Bridge text formatting                         | Serializer changes              |
| `executeGraph.test.ts`            | End-to-end execution with GraphQL schema       | Core wiring, field resolution   |
| `tool-features.test.ts`           | Tool inheritance, wire merging, onError        | Tool block changes              |
| `builtin-tools.test.ts`           | std namespace tools, bundle shape              | Adding/changing stdlib tools    |
| `resilience.test.ts`              | Error fallback, null coalescing, catch         | Fallback chain changes          |
| `control-flow.test.ts`            | break, continue, throw, panic                  | Control flow changes            |
| `expressions.test.ts`             | Ternary, and/or, not, math, comparisons        | Expression/alias changes        |
| `ternary.test.ts`                 | Ternary operator specifics                     | Ternary behavior changes        |
| `chained.test.ts`                 | Pipe operator chains                           | Pipe syntax changes             |
| `scheduling.test.ts`              | Concurrency, dedup, parallelism                | Execution scheduling changes    |
| `force-wire.test.ts`              | `force` statement execution                    | Force statement changes         |
| `scope-and-edges.test.ts`         | Handle scoping, define blocks                  | Define/scope changes            |
| `path-scoping.test.ts`            | Path resolution, nested access                 | Path traversal changes          |
| `tracing.test.ts`                 | Trace output shape, timing                     | Tracing/observability changes   |
| `logging.test.ts`                 | Logger integration                             | Logger changes                  |
| `execute-bridge.test.ts`          | Standalone (non-GraphQL) execution             | `executeBridge()` changes       |
| `string-interpolation.test.ts`    | Template string interpolation                  | String template changes         |
| `interpolation-universal.test.ts` | Universal interpolation                        | Interpolation changes           |
| `coalesce-cost.test.ts`           | Cost-sorted coalesce resolution                | Overdefinition/coalesce changes |
| `fallback-bug.test.ts`            | Specific fallback regression tests             | Fallback regressions            |
| `prototype-pollution.test.ts`     | Security: prototype pollution guards           | Security changes                |
| `email.test.ts`                   | Mutation + response header extraction          | Mutation handling               |
| `property-search.test.ts`         | File-based .bridge fixture test                | Complex multi-tool scenarios    |

### E2E tests

E2E tests live in each example directory and spin up a real GraphQL server:

```bash
pnpm e2e                    # run all e2e tests
cd examples/weather-api && pnpm e2e   # single example
```

| Example                      | What it tests                                   |
| ---------------------------- | ----------------------------------------------- |
| `examples/weather-api/`      | Tool chaining, geocoding + weather, no API keys |
| `examples/builtin-tools/`    | std tools (format, findEmployee)                |
| `examples/composed-gateway/` | Multi-source gateway composition                |
| `examples/travel-api/`       | Provider switching, error fallbacks             |
| `examples/without-graphql/`  | Standalone `executeBridge()` without GraphQL    |

### Test helper

`packages/bridge/test/_gateway.ts` exports `createGateway({ bridgeText, typeDefs, tools?, options? })` — sets up a graphql-yoga server for integration tests. The `_` prefix keeps it out of the test glob.

---

## Documentation Index

End-user documentation lives in `packages/docs-site/src/content/docs/`. Consult these when you need to understand language semantics or user-facing behavior:

### Guides (how-to)

| File                         | Title              | Content                                |
| ---------------------------- | ------------------ | -------------------------------------- |
| `guides/getting-started.mdx` | Getting Started    | First bridge file, setup, basic wiring |
| `guides/bff.mdx`             | The "No-Code" BFF  | Backend-for-Frontend pattern           |
| `guides/egress.mdx`          | The Egress Gateway | Centralizing third-party API calls     |
| `guides/rule-engine.mdx`     | The Rule Engine    | Conditional logic and data enrichment  |

### Language Reference

| File                                      | Title                    | Content                                           |
| ----------------------------------------- | ------------------------ | ------------------------------------------------- |
| `reference/10-core-concepts.mdx`          | Core Concepts            | Mental model, execution engine, file structure    |
| `reference/20-structural-blocks.mdx`      | Structural Blocks        | `bridge`, `tool`, `define`, `const` blocks        |
| `reference/30-wiring-routing.mdx`         | Wiring & Routing         | `<-`, `=`, nested payloads, `force`               |
| `reference/40-using-tools-pipes.mdx`      | Using Tools & Pipes      | Pipe chains, caching                              |
| `reference/50-fallbacks-resilience.mdx`   | Fallbacks & Resilience   | `\|\|`, `??`, `catch`, `on error`, overdefinition |
| `reference/60-expressions-formatting.mdx` | Expressions & Formatting | Math, ternary, string interpolation, `alias`      |
| `reference/70-array-mapping.mdx`          | Array Mapping            | `[] as iter { }`, `break`, `continue`             |

### Built-in Tools Reference

| File                     | Title             | Content                                        |
| ------------------------ | ----------------- | ---------------------------------------------- |
| `tools/10-httpCall.mdx`  | REST API client   | httpCall tool: methods, headers, caching       |
| `tools/11-audit.mdx`     | Audit Log         | Structured logging tool for side-effects       |
| `tools/array-tools.mdx`  | Array Operations  | find, first, toArray, flat, sort, unique, etc. |
| `tools/string-tools.mdx` | String Operations | upper, lower, slice, pad, replace, etc.        |

### Advanced Topics

| File                           | Title             | Content                                       |
| ------------------------------ | ----------------- | --------------------------------------------- |
| `advanced/custom-tools.md`     | Custom Tools      | Writing custom tool functions                 |
| `advanced/dynamic-routing.md`  | Dynamic Routing   | Context-aware instruction selection           |
| `advanced/input-validation.md` | Asserting Inputs  | assert tool for input validation              |
| `advanced/observability.md`    | Observability     | Traces, metrics, and logs                     |
| `advanced/packages.mdx`        | Package Selection | Choosing the right packages for your use case |

### Internal developer docs

| File                | Content                                                                |
| ------------------- | ---------------------------------------------------------------------- |
| `docs/developer.md` | Architecture deep-dive: parser pipeline, execution engine, serializer  |
| `docs/llm-notes.md` | Detailed internal notes: types, APIs, design decisions, test structure |
| `docs/roadmap/*.md` | Future feature planning documents                                      |

---

## Key Concepts to Understand

### The Wire type

All data flow is expressed as `Wire` — a discriminated union with 5 variants:

1. **Pull wire** (`from → to`) — pull data from a source at runtime
2. **Constant wire** (`value → to`) — set a fixed value
3. **Conditional wire** (`cond ? then : else → to`) — ternary
4. **condAnd wire** (`left && right → to`) — short-circuit AND
5. **condOr wire** (`left || right → to`) — short-circuit OR

All wire variants (except constant) support modifier layers:

- `falsyFallbackRefs` + `falsyFallback` + `falsyControl` — falsy gate (`||`)
- `nullishFallbackRef` + `nullishFallback` + `nullishControl` — nullish gate (`??`)
- `catchFallbackRef` + `catchFallback` + `catchControl` — error boundary (`catch`)

### The ExecutionTree

Pull-based: resolution starts from a demanded field and works backward. Key methods:

- `resolveWires(wires)` — unified loop over all wire types with 3 modifier layers + overdefinition boundary
- `pullSingle(ref)` — recursive resolution of a single NodeRef
- `schedule(target)` — schedules a tool call, builds its input from wires
- `callTool(...)` — invokes a tool function with OpenTelemetry tracing

### The Parser

Chevrotain CstParser. Two-phase: grammar rules produce CST, then `toBridgeAst` visitor converts to typed `Instruction[]`. When adding syntax:

1. Add token in `lexer.ts` (with `longer_alt: Identifier`)
2. Add grammar rule in `parser.ts`
3. Add visitor logic in `toBridgeAst`
4. Add parser-compat snapshot test
5. Update serializer in `bridge-format.ts` if round-trip is needed

---

## Common Patterns

### Adding a new built-in tool

1. Create the tool in `packages/bridge-stdlib/src/tools/`
2. Export from `packages/bridge-stdlib/src/index.ts` under the `std` namespace
3. Add tests in `packages/bridge/test/builtin-tools.test.ts`
4. Update `packages/docs-site/` with documentation
5. Update the VS Code extension syntax if new keywords are involved

### Changing parser/language syntax

1. Modify tokens in `bridge-compiler/src/parser/lexer.ts`
2. Add/modify grammar rules in `bridge-compiler/src/parser/parser.ts`
3. Update visitor logic in the same file
4. Update serializer in `bridge-compiler/src/bridge-format.ts`
5. Add snapshot tests in `packages/bridge/test/parser-compat.test.ts`
6. Add execution tests in the relevant test file

### Changing execution semantics

1. Modify `bridge-core/src/ExecutionTree.ts`
2. Add tests in the relevant test file (usually `executeGraph.test.ts`, `resilience.test.ts`, or `expressions.test.ts`)
3. Verify with `pnpm test && pnpm e2e`

---

## TypeScript Conventions

- **Module system:** ESM (`"type": "module"`)
- **Import extensions:** Use `.ts` extensions in source imports (the `rewriteRelativeImportExtensions` compiler option handles build output)
- **Strict mode:** All strict checks enabled
- **Build:** `tsc` per package, output to `build/`
- **Dev running:** `--experimental-transform-types --conditions source` (runs TypeScript directly, resolves `source` export condition to `src/`)
- **Path mappings:** `tsconfig.base.json` maps `@stackables/*` packages for cross-package imports during development
