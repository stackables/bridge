# The Bridge Language — VS Code Extension

Full IDE support for [The Bridge](https://github.com/stackables/bridge): a declarative dataflow language for GraphQL. Wire data between APIs and schema fields using `.bridge` files — no resolvers, no codegen, no plumbing.

![Bridge syntax highlighting and language server in action](./packages/bridge-syntax-highlight/syntax-image.png)

## Features

### Language Server (LSP)

- **Real-time diagnostics** — syntax errors and semantic issues highlighted as you type
- **Semantic validation** — undeclared handles, unsatisfied `with` dependencies, and unknown wire targets flagged immediately
- **Hover information** — hover over any handle, dependency, or declaration to see its type and source
  - Bridge hover: type/field name, handle count, wire count
  - Tool hover: function name, deps, wires
  - Define hover: subgraph details
  - Const hover: name and raw value
- Error recovery — partial AST is built even on broken files, so diagnostics remain accurate while you're mid-edit

### Syntax Highlighting

- Full syntax highlighting for `.bridge` files (language version 1.4)
- Block keyword highlighting: `version`, `const`, `tool`, `define`, `bridge`
- Wire operator colouring: `<-` (pull), `<-!` (force), `||` (null-coalesce), `??` (error-fallback), `:` (pipe)
- Distinct colours for GraphQL type/field targets in `bridge` declarations
- Tool handle and alias highlighting
- Built-in handle highlighting: `input`, `output`, `context`
- Constant assignment colouring: `.property = value`
- HTTP method constants: `GET`, `POST`, `PUT`, `DELETE`, `PATCH`, `HEAD`, `OPTIONS`
- Unquoted URL path values (e.g. `/search`, `/api/v1/forecast`)
- Array mapping syntax: `source[] as iter { … }`
- `on error` fallback declarations inside `tool` blocks
- String, number, boolean, and `null` literals

### Editor Integration

- Line comment toggling (`#`)
- Bracket matching for `{}` and `[]`
- Automatic language detection for `*.bridge` files

## Installation

Search for **"The Bridge Language"** in the VS Code Extensions panel, or install from the terminal:

```bash
code --install-extension stackables.bridge-syntax-highlight
```

Files named `*.bridge` are automatically detected.

## Related

- [The Bridge runtime](https://github.com/stackables/bridge) — `@stackables/bridge` on npm
- [Language reference](https://github.com/stackables/bridge/blob/main/docs/bridge-language-guide.md) — full syntax documentation

---

## Release Notes

See [CHANGELOG.md](CHANGELOG.md).
