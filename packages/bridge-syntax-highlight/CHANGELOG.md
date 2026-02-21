# Change Log

All notable changes to the "bridge" extension will be documented in this file.

## [0.5.0] - 2026-02-21

### Added

- **Language Server** with real-time diagnostics and hover information
- Syntax error diagnostics powered by Chevrotain parser with error recovery (partial AST even on broken files)
- Semantic diagnostics: undeclared handles, unsatisfied `with` dependencies
- Hover provider: hover over any handle, dependency, or wire name to see its type and declaration context

## [0.0.1] - 2026-02-21

### Added

- Syntax highlighting for Bridge language version 1.4
- Support for all top-level blocks: `version`, `const`, `tool`, `define`, `bridge`
- Wire operator highlighting: `<-`, `<-!`, `||`, `??`, `:`
- Array mapping syntax: `source[] as iter { … }`
- Constant assignment highlighting: `.property = value`
- Built-in handle highlighting: `input`, `output`, `context`
- HTTP method constants: `GET`, `POST`, `PUT`, `DELETE`, `PATCH`, etc.
- Unquoted URL path values (e.g. `/search`, `/forecast`)
- `on error` fallback declarations
- Block brace matching
- Comment support (`#` line comments)
- String, number, and boolean literal highlighting
- `language-configuration.json` for bracket matching and comment toggling