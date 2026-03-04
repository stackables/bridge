---
"@stackables/bridge-compiler": patch
"@stackables/bridge-parser": patch
---

Fix several AOT compiler/runtime parity bugs discovered via fuzzing:

- Fix `condAnd` and `condOr` code generation to match runtime boolean semantics.
- Fix nullish fallback chaining so `??` handling matches runtime overdefinition boundaries.
- Fix overdefinition precedence so the first constant wire remains terminal, matching runtime behavior.
- Fix `serializeBridge` quoting for empty-string and slash-only string constants so parse/serialize/parse round-trips remain valid.
- Add deterministic regression coverage for these parity cases to prevent regressions.
