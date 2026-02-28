---
"@stackables/bridge-compiler": minor
"@stackables/bridge-core": minor
"@stackables/bridge-graphql": minor
"@stackables/bridge": minor
---

Wrap compiler output in a `BridgeDocument` type (`{ version?: string; instructions: Instruction[] }`) instead of returning a bare `Instruction[]`. This lifts the version declaration to a document-level field and removes `VersionDecl` from the `Instruction` union.

**Breaking changes:**

- `parseBridge()` and `parseBridgeDiagnostics()` now return `BridgeDocument` (an object) instead of `Instruction[]`
- `executeBridge()` accepts `{ document }` instead of `{ instructions }`
- `bridgeTransform()` accepts `DocumentSource` (renamed from `InstructionSource`)
- `VersionDecl` is no longer part of the `Instruction` discriminated union

**Migration:** Replace `parseBridge(src)` array usage with `parseBridge(src).instructions`. Update `executeBridge({ instructions })` calls to `executeBridge({ document })`. Rename `InstructionSource` imports to `DocumentSource`. Use `mergeBridgeDocuments()` instead of manual instruction array spreading when composing multiple bridge files.
