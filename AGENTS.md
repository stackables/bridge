# AGENTS.md — Coding Agent Instructions

> For AI coding agents working on The Bridge codebase.

## What is The Bridge?

A declarative dataflow language (`.bridge` files) and pull-based execution engine for API orchestration. Developers describe **what** data they need and **where** it comes from; the engine builds a dependency graph and executes it automatically.

**pnpm monorepo** — packages under `packages/`, examples under `examples/`.

## Prerequisites

- **Node.js ≥ 24**, **pnpm ≥ 10**
- `nvm use 24` or similar in case correct node is not already installed
- `pnpm install` to set up


## Mandatory Workflow

### Always verify

```bash
pnpm build       # type-check (0 errors required)
pnpm lint        # coding standards (0 errors required)
pnpm test        # all unit tests (0 failures baseline)
pnpm e2e         # end-to-end tests
```

If tests fail before your changes, **fix them first**.

### Test requirements

- **Bug fixes:** write a failing test first, then fix
- **New features:** every new feature, syntax addition, or behavioral change needs test coverage
- Tests use `node:test` + `node:assert` — no Jest or Vitest

### Changesets

Run `pnpm changeset` for every **user-facing** change. Skip for test-only, docs, or CI changes.

### Language changes

For every language change, also review and adjust the **playground** and **VS Code extension** (syntax highlighting, autocomplete).

## Package Architecture

```
bridge-types/          Shared type definitions
bridge-stdlib/         Standard library tools (httpCall, strings, arrays, audit, assert)
bridge-core/           Execution engine (ExecutionTree), core types (Wire, Bridge, NodeRef)
bridge-parser/         Parser (Chevrotain), serializer, linter, language service
bridge-compiler/       AOT compiler (bridge → optimised JS)
bridge-graphql/        GraphQL schema adapter (bridgeTransform)
bridge/                Umbrella — re-exports everything as @stackables/bridge
bridge-syntax-highlight/  VS Code extension (TextMate grammar, language server)
docs-site/             Documentation website (Astro + Starlight)
playground/            Browser playground (Vite + React)
```

**Dependency flow (no cycles):** `bridge-types → bridge-stdlib → bridge-core → bridge-parser → bridge-compiler → bridge-graphql → bridge`

## Tests

**Run a single test file:**
```bash
node --experimental-transform-types --test test/<filename>.test.ts
```

Tests are **co-located with each package**. The main test suites:

- **`packages/bridge/test/`** — language behavior, execution engine, expressions, control flow, resilience, scheduling, etc.
- **`packages/bridge-graphql/test/`** — GraphQL driver: per-field errors, tracing via extensions, logging, mutations, field fallthrough.
- **`packages/bridge-core/test/`**, **`packages/bridge-stdlib/test/`**, **`packages/bridge-parser/test/`** — package-level unit tests.
- **`examples/*/e2e.test.ts`** — end-to-end tests spinning up real servers.

## TypeScript Conventions

- **ESM** (`"type": "module"`) with `.ts` import extensions (handled by `rewriteRelativeImportExtensions`)
- **Strict mode** — `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch`
- **Dev running:** `--experimental-transform-types`
- **Path mappings:** `tsconfig.base.json` maps `@stackables/*` for cross-package imports

## Deep-dive docs

For architecture details, internal types, Wire semantics, parser pipeline, and design decisions, see:
- `docs/developer.md` — architecture deep-dive
- `docs/llm-notes.md` — detailed internal notes for LLMs
- `packages/docs-site/src/content/docs/` — end-user language reference
