---
"@stackables/bridge-compiler": minor
"@stackables/bridge-core": minor
"@stackables/bridge": minor
---

Add `@version` syntax to `with` statements for tool versioning. Bridge handles and tool dependencies can now include a version tag (e.g., `with geocoder@2.1 as geo`) that is stored as metadata on the binding and preserved through parse → serialize round-trips.
