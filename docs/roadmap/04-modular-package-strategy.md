## Modular Package Strategy & AOT Ergonomics

**Status:** Planned
**Target Release:** v2.0 (Architecture Finalization)

### 📖 The Problem: The Monolith Penalty

The Bridge has evolved into a highly capable toolchain: a Chevrotain compiler, a cost-based execution engine, a GraphQL adapter, and a CLI.

Currently, these are tightly coupled. If a developer wants to run a `.bridge` file natively in a serverless Edge function (without GraphQL), they are still forced to bundle `chevrotain` and `graphql-js`. This introduces unnecessary bloat, security surface area, and cold-start latency.

We need a modular package strategy that isolates dependencies, combined with an ergonomic developer workflow for Ahead-Of-Time (AOT) compilation.

### ✨ Proposed Solution: The Bridge Ecosystem

We will split the monolith into discrete, purpose-built packages (or strict subpath exports). The core engine will become a hyper-lightweight, dependency-free runner that accepts pre-compiled JSON ASTs. Framework-specific logic (like GraphQL) and heavy dev-tools (like the Compiler) will be strictly opt-in.

### 📦 The Package Strategy

1. **`@stackables/bridge-core` (The Runtime)**
* **What it is:** The pure `ExecutionTree`, cost-scheduler, and `std` tools.
* **Dependencies:** ZERO. (No `chevrotain`, no `graphql-js`).
* **Size:** < 10kb gzipped.
* **Input:** Accepts a serialized JSON AST (`Instruction[]`).
* **Use Case:** Embedded directly in Edge workers, browsers, or internal microservices using the `tree.run(input)` standalone mode.


2. **`@stackables/bridge-compiler` (The Parser)**
* **What it is:** The Chevrotain Lexer, Parser, and AST Visitor.
* **Input/Output:** Takes `string` (`.bridge` text), outputs `Instruction[]` (JSON AST).


3. **`@stackables/bridge-graphql` (The Adapter)**
* **What it is:** The GraphQL field resolver wrapper (the `response(ipath)` method).
* **Dependencies:** Peer dependency on `graphql-js` and `@stackables/bridge-core`.
* **Use Case:** Developers running standard Apollo/Yoga servers.


4. **`@stackables/bridge-cli` (The Dev Tools)**
* **What it is:** The command-line interface utilizing the Compiler.
* **Commands:**
* `bridge check`: Lints the graph in CI/CD pipelines.
* `bridge build`: Compiles `.bridge` files into `.bridge.json` artifacts for AOT deployments.





### 🧑‍💻 Developer Ergonomics (How it gets used)

By splitting the packages, we unlock two distinct, highly ergonomic workflows:

**Workflow A: The Full GraphQL Server (JIT Parsing)**
For standard backend devs who want the easiest setup.

1. `npm install @stackables/bridge-graphql graphql`
2. At server startup, they pass the `.bridge` file strings to a setup function.
3. The package parses the text Just-In-Time (JIT) and maps the execution engine to the GraphQL schema.

**Workflow B: The Standalone Edge API (AOT Compilation)**
For performance-obsessed devs deploying to Cloudflare Workers or AWS Lambda.

1. During their GitHub Actions build step, they run `npx @stackables/bridge build`. It outputs `routes.bridge.json`.
2. The production worker *only* installs `@stackables/bridge-core`.
3. At runtime, the worker imports the JSON artifact and feeds it to the `ExecutionTree`. **Zero parsing time, zero GraphQL overhead.** 

### 🛠️ Implementation Sketch
4. **Monorepo Setup:** Migrate the codebase to an npm/pnpm workspace to manage the split packages.
5. **Isolate `graphql`:** Move the GraphQL `Path` types and the `response()` method out of `ExecutionTree.ts` and into the new adapter package.
6. **Formalize the AST:** Since the core engine and compiler will now live in separate packages, extract the AST types (`Instruction`, `Bridge`, `Wire`) into a shared `@stackables/bridge-types` package to ensure strict contract compatibility.
7. **Wire up the CLI:** Connect the existing linter and parsing logic to standard `yargs` or `commander` CLI commands for the `build` and `check` lifecycle.

