# Contributing to The Bridge

Thanks for your interest in contributing! This document covers everything you need to get started.

---

## Prerequisites

- **Node.js ≥ 22** (the test runner uses `node:test` APIs that require it)
- **pnpm ≥ 10** — install with `npm install -g pnpm`

---

## Setup

```bash
git clone https://github.com/stackables/bridge.git
cd bridge
pnpm install
```

That's it — no separate build step needed for development. The test suite uses `tsx` to run TypeScript directly.

---

## Running Tests

```bash
# All packages
pnpm test

# Just the main package (faster iteration)
cd packages/bridge
pnpm test

# Single test file
cd packages/bridge
node --import tsx/esm --test test/parser-compat.test.ts
```

Tests use the built-in `node:test` runner. No Jest, no Vitest. Output is TAP-style with a summary at the end.

---

## Building

```bash
pnpm build         # all packages
cd packages/bridge && pnpm build   # just the runtime
```

The build outputs to `packages/bridge/build/` and is what gets published to npm. You never need to build to run tests — `tsx` handles TypeScript directly.

---

## TypeScript

This project uses strict TypeScript. The tsconfig enforces:

| Flag | Why |
|---|---|
| `strict` | All standard strict checks (noImplicitAny, strictNullChecks, etc.) |
| `noUnusedLocals` | Unused imports and variables are compile errors |
| `noUnusedParameters` | Unused function parameters are compile errors |
| `noImplicitReturns` | Every code path must return |
| `noFallthroughCasesInSwitch` | Switch cases must not silently fall through |

---

## Project Structure

```
packages/
  bridge/             — The main runtime package (@stackables/bridge)
    src/              — TypeScript source (edit here)
    test/             — Test files
    build/            — Compiled output (committed; not for editing)
  bridge-syntax-highlight/   — VS Code extension for .bridge files
examples/             — Runnable examples (weather-api, builtin-tools, composed-gateway)
docs/                 — Language guide, roadmap, developer notes
```

For a detailed walkthrough of the internals, see [docs/developer.md](docs/developer.md).

---

## Making Changes

### Parser / Language

The parser is in `packages/bridge/src/parser/`. It uses [Chevrotain](https://chevrotain.io):

1. **Tokens** are defined in `lexer.ts`
2. **Grammar rules** live in `parser.ts` (the `BridgeParser` class, ~line 90)
3. **CST → AST** transformation is also in `parser.ts` (the `toBridgeAst` visitor, ~line 820)

If you add a new keyword or syntax:
- Add a token in `lexer.ts` with `longer_alt: Identifier` so it doesn't steal valid identifiers
- Add the grammar rule to `BridgeParser`
- Add the visitor logic in `toBridgeAst`
- Add a `parser-compat.test.ts` snapshot for the new construct
- Update `docs/bridge-language-guide.md`

### Built-in Tools

Tools live in `packages/bridge/src/tools/`. Each tool is a TypeScript file that exports a function matching `ToolCallFn`:

```typescript
// src/tools/my-tool.ts
export function myTool(input: Record<string, any>): Promise<Record<string, any>> {
  // ...
}
```

Then register it in `src/tools/index.ts` under the `std` namespace:

```typescript
export const std = { ..., myTool };
```

Add tests in `test/builtin-tools.test.ts`.

### Engine / Execution

The execution engine is `src/ExecutionTree.ts`. It is pull-based: field resolution starts from a GraphQL request, travels backward through wire declarations, and invokes tools only when their output is actually needed.

If you change execution semantics, add a test in `test/executeGraph.test.ts` or the relevant feature test file.

---

## Test Files Overview

| File | What it covers |
|---|---|
| `parser-compat.test.ts` | Parse → serialize round-trips (snapshot-style) |
| `bridge-format.test.ts` | Bridge text formatting |
| `executeGraph.test.ts` | End-to-end execution with a real GraphQL schema |
| `tool-features.test.ts` | Tool inheritance, wires, onError |
| `builtin-tools.test.ts` | std namespace tools |
| `resilience.test.ts` | Error fallback, null coalescing |
| `scheduling.test.ts` | Concurrency and deduplication of tool calls |
| `tracing.test.ts` | Trace output shape |
| `logging.test.ts` | Logger integration |
| `http-executor.test.ts` | httpCall tool |
| `chained.test.ts` | Pipe operator chains |
| `scope-and-edges.test.ts` | Handle scoping, define blocks |

---

## Pull Requests

- Keep PRs focused — one feature or fix per PR
- All tests must pass (`pnpm test`)
- `tsc --noEmit` must be clean (the strict flags will catch issues)
- For language changes, update `docs/bridge-language-guide.md`
- For new tools, add them to the built-in tools example

---

## Questions

Open a [GitHub Discussion](https://github.com/stackables/bridge/discussions) or file an issue.
