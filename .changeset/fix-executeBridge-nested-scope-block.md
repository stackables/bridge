---
"@stackables/bridge-core": patch
"@stackables/bridge": patch
---

Fix `executeBridge` returning `undefined` for nested object fields defined via scope blocks (`o.field { .sub <- ... }`).

Previously, `run()` only resolved top-level output fields with exact path matches. Wires produced by scope blocks (e.g. `o.why { .temperature <- api.deg }`) have paths like `["why", "temperature"]`, so `pullOutputField(["why"])` found nothing and returned `undefined`.

The fix builds nested output objects recursively: when no exact wire matches a field path, it collects all deeper-path wires under that prefix and assembles the nested object, matching the behaviour already available in the GraphQL resolver path.
