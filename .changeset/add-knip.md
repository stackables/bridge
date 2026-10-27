---
"@stackables/bridge-core": patch
"@stackables/bridge-compiler": patch
"@stackables/bridge-parser": patch
"@stackables/bridge-graphql": patch
---

Remove unused code and dependencies found by knip: the unused `@opentelemetry/api` dependency of bridge-core and the unused `@stackables/bridge-types` dependency of bridge-compiler, plus unexported dead helpers.
