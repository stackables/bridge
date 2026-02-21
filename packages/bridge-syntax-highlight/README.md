# The Bridge Language — VS Code Extension

Syntax highlighting for [The Bridge](https://github.com/stackables/bridge): a declarative dataflow language for GraphQL. Wire data between APIs and schema fields using `.bridge` files—no resolvers, no codegen, no plumbing.

## Features

- Full syntax highlighting for `.bridge` files (language version 1.4)
- Block keyword highlighting: `version`, `const`, `tool`, `define`, `bridge`
- Wire operator colouring: `<-` (pull), `<-!` (force/push), `||` (null-coalesce), `??` (error-fallback), `:` (pipe)
- Distinct colours for GraphQL type/field targets in `bridge` declarations
- Tool handle and alias highlighting
- Built-in handle highlighting: `input`, `output`, `context`
- Constant assignment colouring: `.property = value`
- HTTP method constants: `GET`, `POST`, `PUT`, `DELETE`, `PATCH`, `HEAD`, `OPTIONS`
- Unquoted URL path values (e.g. `/search`, `/api/v1/forecast`)
- Array mapping syntax: `source[] as iter { … }`
- `on error` fallback declarations inside `tool` blocks
- String, number, boolean, and `null` literals
- Line comment toggling (`#`)
- Bracket matching for `{}` and `[]`

## Installation

Search for **"The Bridge Language"** in the VS Code Extensions panel, or install from the terminal:

```bash
code --install-extension stackables.bridge
```

Files named `*.bridge` are automatically detected and highlighted.

## Related

- [The Bridge runtime](https://github.com/stackables/bridge) — `@stackables/bridge` on npm
- [Language reference](https://github.com/stackables/bridge#the-language) — full syntax documentation

---

## Release Notes

See [CHANGELOG.md](CHANGELOG.md).
