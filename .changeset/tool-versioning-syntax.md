---
"@stackables/bridge-compiler": minor
"@stackables/bridge-core": minor
"@stackables/bridge-graphql": minor
"@stackables/bridge-stdlib": minor
"@stackables/bridge": minor
---

Add `@version` syntax to `with` statements for tool versioning. Bridge handles and tool dependencies can now include a version tag (e.g., `with geocoder@2.1 as geo`) that is stored as metadata on the binding and preserved through parse → serialize round-trips.

The `version` header now accepts any minor version within the same major (e.g., `version 1.7` on a `1.x` parser). A `VersionDecl` instruction is emitted in the AST, and the engine validates at runtime that the installed standard library satisfies the bridge file's declared minimum version — producing a clear error message when a newer std is needed.

**Versioned tool validation & injection:** Handles with `@version` tags are validated at startup. For `std.*` tools, the bundled std version is checked; for custom tools, user must provide a versioned tool key (e.g., `"myApi.getData@2.0": fn`). The engine prefers versioned tool functions when available, enabling side-by-side version coexistence. The language service emits warnings for `@version` tags exceeding the bundled std.
