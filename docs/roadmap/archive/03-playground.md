## The Browser Playground & Editor-Agnostic Language Service

**Status:** Delivered (core); future work on execution-inferred IntelliSense

### What Shipped

The playground is a fully client-side Vite + React 19 app deployed on
Cloudflare Workers. No proxy server, no backend — the Bridge engine runs
entirely in the browser.

Stack: CodeMirror 6, Tailwind CSS 4, `@cloudflare/vite-plugin`, wrangler.

#### Four-Panel Layout

The original plan called for four panels. All four are implemented:

| # | Panel | What it does |
|---|-------|-------------|
| 1 | **Schema** | GraphQL SDL editor with live validation (`buildSchema()` → CodeMirror diagnostics). |
| 2 | **Bridge DSL** | `.bridge` editor with syntax highlighting, diagnostics, and keyword / handle / tool completions — all powered by `BridgeLanguageService`. |
| 3 | **Query** | GraphQL operation editor with schema-aware autocomplete (`cm6-graphql`). Includes a **Context** tab for editing the JSON context object passed to execution. Supports multiple query tabs with auto-naming from operation names. |
| 4 | **Result** | JSON output, inline error display, expandable trace viewer, expandable log viewer, and a "Clear Cache" button. |

Desktop uses resizable panels; mobile falls back to a vertical scroll
layout.

#### In-Browser Execution

`engine.ts` runs the full pipeline client-side:

1. `parseBridgeChevrotain()` — parse the DSL
2. `bridgeTransform()` — compile into a GraphQL schema with Bridge resolvers
3. `graphql.execute()` — run the user's query

HTTP calls use `createHttpCall(globalThis.fetch, playgroundHttpCache)` —
native browser `fetch` with a module-level LRU cache that the user can clear
from the UI.

Full tracing is enabled (`trace: "full"`). A `collectingLogger` captures all
structured log entries so they can be displayed in the result panel.

#### BridgeLanguageService — One Service, Three Consumers

The original plan proposed a separate `@stackables/bridge-language-service`
package with per-editor adapter packages (`monaco-bridge`,
`codemirror-bridge`, `vscode-bridge`). In practice, a simpler architecture
emerged:

* **`BridgeLanguageService`** lives in `packages/bridge/src/language-service.ts`
  and is exported from `@stackables/bridge`. It is a plain TypeScript class
  with no editor or transport dependencies.
* **Consumers** are thin adapters:
  * *Playground* — four small files in `packages/playground/src/codemirror/`
    map diagnostics and completions to CodeMirror 6.
  * *VS Code extension* — an LSP server in
    `packages/bridge-syntax-highlight/src/server.ts` wraps the same service.
  * *CLI* — `bridge-lint` feeds file contents through the service and prints
    diagnostics.

This is intentional: separate adapter packages would add build and versioning
overhead with no clear benefit while the consumer list is small.

#### Share & Examples

* **Share** — a Cloudflare KV-backed API (`POST /api/share`, `GET /api/share/:id`)
  generates short IDs appended as `?s=<id>`. Payloads are capped at 128 KB
  with a 90-day TTL.
* **Examples** — a dropdown pre-loads curated configurations (schema + bridge +
  query) so new users can explore without writing anything.

### What Is Not Yet Delivered

#### Execution-Inferred IntelliSense

The original plan's headline feature: as the user executes queries, the engine
captures raw REST JSON responses and feeds inferred type information back into
the language service so the editor can autocomplete `api.*` fields based on
real data.

Today `BridgeLanguageService` provides **static** completions — keywords,
built-in tool names, and declared handles — but it does not capture or infer
external API response shapes.

Delivering this requires:

1. **Capture** — intercept tool inputs and outputs during execution (the
   tracing infrastructure already collects this data).
2. **Reduce** — merge captured JSON samples into a union type schema
   (e.g. `string | null`).
3. **Feed** — push the inferred schema into `BridgeLanguageService` so it can
   offer `api.*` completions and flag likely typos.
4. **Persist (VS Code)** — write the inferred schema to a cache file
   (`.bridge-types.json` or similar) so the VS Code extension can pick it up
   across sessions.

Step 1 is largely in place thanks to `trace: "full"`. The remaining work is
in the language service itself.

### Constraints

* **CORS** — the playground executes HTTP calls directly from the browser.
  APIs that do not set CORS headers will fail. The engine surfaces fetch
  errors in the result panel, but a more specific "this looks like a CORS
  block" diagnostic would improve the experience.
* **Cold start for inference** — once execution-inferred IntelliSense is
  implemented, `api.*` completions will only be available after at least one
  successful execution populates the inference engine. This is inherent to
  the approach.
