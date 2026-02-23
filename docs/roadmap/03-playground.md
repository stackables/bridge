## The Browser Playground & Editor-Agnostic Language Service

**Status:** Planned
**Target Release:** v1.x / v2.0

### 📖 The Problem

Currently, evaluating The Bridge requires setting up a local Node.js environment, writing a GraphQL schema, and running a dev server. Furthermore, while the `.bridge` language is strictly typed on the GraphQL side (`i.` and `o.`), external REST APIs are opaque black boxes. Developers have to guess what fields an external API returns, leading to frustrating trial-and-error wiring and typos.

We need a zero-friction way for developers to try The Bridge in the browser, and a "magical" developer experience that bridges the gap between strict GraphQL and untyped REST—without locking ourselves into a single editor ecosystem.

### ✨ The Solution: An Execution-Aware Playground & Core Language Service

We will build a fully client-side interactive playground (no server infra, no proxying) powered by a new, standalone `@stackables/bridge-language-service`.

As developers test their GraphQL queries in the browser, the underlying Bridge engine will capture the raw REST JSON responses and feed them directly into the Language Service. **The editor literally learns the shape of the external APIs as you type and execute.**

### 🖥️ The Playground Experience (Four-Panel Layout)

1. **Schema Editor:** GraphQL SDL with standard syntax highlighting.
2. **Bridge Editor:** `.bridge` file editor (Monaco or CodeMirror) powered by our custom language service (diagnostics, hover, autocomplete).
3. **Query Editor:** GraphQL operation editor. Autocomplete here is driven directly by panel #1.
4. **Response Panel:** Live JSON output from the execution engine.

### 🧠 Execution-Inferred IntelliSense (How the magic works)

To power the Bridge Editor (Panel 2), the Language Service will feature two new capabilities:

1. **Static GraphQL Binding:** The service reads the local schema to provide instant, strict IntelliSense for `i.*` (input arguments) and `o.*` (output fields).
2. **Dynamic Execution Inference:** * When a user runs a query, the browser-based Bridge engine executes the actual HTTP requests directly to the external APIs.
* The engine intercepts the raw input/output JSON of every tool execution and reduces it into a unified type schema (handling unions like `number | null` across multiple runs).
* This inferred schema is immediately pushed to the in-memory Language Service.
* **The result:** When the user types `api.`, the editor provides perfect autocomplete based on the *actual data* the API just returned in Panel 4. It will also flag warnings for typos.



### 🛠️ Architecture & Implementation Sketch

This feature shifts our tooling architecture to be completely modular:

* **Core Language Service:** A pure TypeScript package (`@stackables/bridge-language-service`) that takes a `.bridge` file string, a GraphQL Schema, and inferred JSON types, and returns standard arrays of Diagnostics, Completions, and Hover info.
* **Editor Adapters (Bridges):** Lightweight wrapper packages that map the Core Language Service outputs to specific editor APIs:
* `monaco-bridge`: Adapter for Monaco (used in the heavy playground).
* `codemirror-bridge`: Adapter for CodeMirror (perfect for lightweight doc-site embeds).
* `vscode-bridge`: The Node.js Language Server Protocol (LSP) wrapper for the official VS Code extension.


* **Browser Engine:** The `@stackables/bridge` core engine is almost entirely pure JS. We will swap the Node.js `std.httpCall` tool for a native browser `fetch` implementation.
* **VS Code Parity:** For local VS Code development, local Node.js executions will write inferred traces to a `.bridge-types.json` cache file, which the `vscode-bridge` LSP wrapper will watch and feed into the Core Language Service.

### ⚠️ Challenges & Constraints

* **CORS:** Because the playground runs in the browser, users can only test against APIs that allow CORS. We will need to surface clear, friendly errors when a CORS block occurs.
* **The Cold Start:** Autocomplete for tools won't work until the user executes at least one successful query to populate the inference engine.
