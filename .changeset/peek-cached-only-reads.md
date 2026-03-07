---
"@stackables/bridge": minor
"@stackables/bridge-parser": minor
"@stackables/bridge-core": minor
"@stackables/bridge-compiler": minor
"@stackables/bridge-syntax-highlight": minor
---

Add the `peek` keyword for cached-only reads. `peek ref` reuses a value only when it is already available in the current request and otherwise yields `undefined` without scheduling new work.
