---
"@stackables/bridge-parser": minor
"@stackables/bridge-compiler": major
---

Rename `@stackables/bridge-compiler` to `@stackables/bridge-parser` (parser, serializer, language service). The new `@stackables/bridge-compiler` package compiles BridgeDocument into optimized JavaScript code with abort signal support, tool timeout, and full language feature parity.

bridge-parser first release will continue from current bridge-compiler version 1.0.6. New version of bridge-compiler will jump to 2.0.0 to mark a breaking change in the package purpose
