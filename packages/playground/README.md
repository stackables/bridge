# Bridge Playground

Interactive browser-based playground for the [Bridge](https://github.com/stackables/bridge) declarative dataflow language. Edit Bridge DSL, GraphQL schema, and queries side by side — everything runs client-side, no server required.

## Quick start

```bash
pnpm install
pnpm dev          # http://localhost:5173
pnpm build        # static site → dist/
```

The `dist/` folder can be deployed to any static hosting (Cloudflare Pages, GitHub Pages, Netlify, etc.).

## Architecture

| Layer | Tech | Notes |
|---|---|---|
| UI framework | React 19 + Tailwind CSS 4 | Single-page app with resizable panels |
| Code editor | CodeMirror 6 | Replaces plain `<textarea>` for syntax highlighting and editing |
| Bridge engine | `@stackables/bridge` | Runs entirely in the browser — parser, transform, and execution |
| GraphQL | `graphql` (reference impl) | `buildSchema` + `execute` in-process, no HTTP |
| Build | Vite | Static output, no SSR |

## Design decisions

### Syntax highlighting: CodeMirror StreamLanguage (not TextMate / Shiki)

The VS Code extension (`bridge-syntax-highlight`) uses a TextMate grammar (`bridge.tmLanguage.json`) for highlighting. Ideally the playground would reuse the same grammar definition to avoid duplication.

**Why we can't reuse it directly:**

- CodeMirror 6 uses its own grammar system ([Lezer](https://lezer.codemirror.net/)) — it does not consume TextMate `.tmLanguage.json` files.
- [Shiki](https://shiki.matsu.io/) can load TextMate grammars in the browser, but its CodeMirror integration (`@shikijs/codemirror`) no longer exists as a published package.
- The only viable bridge between TextMate and CodeMirror would be loading the WASM Oniguruma engine plus a TextMate-to-CodeMirror adapter — heavy and fragile for a playground.

**What we do instead:**

We maintain a lightweight **StreamLanguage tokenizer** (`src/codemirror/bridge-lang.ts`, ~200 lines) that mirrors the TextMate grammar rules:

- Same keyword set (`bridge`, `tool`, `define`, `const`, `with`, `version`, `on error`)
- Same operator highlight (`<-`, `<-!`, `||`, `??`, `=`, `:`)
- Same contextual header parsing (`bridge Type.field`, `tool name from source`, `with target as alias`)
- Same literals (strings, numbers, booleans, HTTP methods, URL paths)

The token names map to `@lezer/highlight` tags via CodeMirror's built-in StreamLanguage bridge: `keyword` → `tags.keyword`, `def` → `tags.definition(tags.variableName)`, etc.

**When to revisit:**

- If Shiki re-publishes a CodeMirror integration, we could switch to consuming `bridge.tmLanguage.json` directly.
- If the TextMate grammar grows significantly (e.g. embedded JSON, multi-line constructs), keeping the StreamLanguage tokenizer in sync may become burdensome — at that point consider writing a full Lezer grammar instead.
- Track: the canonical grammar lives in `packages/bridge-syntax-highlight/syntaxes/bridge.tmLanguage.json`.

### Theme

The CodeMirror theme (`src/codemirror/theme.ts`) matches the playground's slate-950 dark palette. Token colours are chosen to align with the TextMate scope-to-colour mapping used by the VS Code extension, so highlighting looks consistent across both environments.

## File structure

```
src/
  App.tsx                     Main layout (panels, header, diagnostics bar)
  engine.ts                   Browser-side bridge engine (parse → transform → execute)
  examples.ts                 Built-in example definitions
  main.tsx                    React entry point
  index.css                   Tailwind entry
  components/
    Editor.tsx                CodeMirror 6 editor wrapper (React)
    ResultView.tsx            JSON result + error display
    TraceDialog.tsx           Trace viewer dialog
    ui/                       shadcn/ui primitives
  codemirror/
    bridge-lang.ts            Bridge DSL StreamLanguage tokenizer
    theme.ts                  Dark theme + syntax highlight colours
  lib/
    utils.ts                  Tailwind merge helper
```
