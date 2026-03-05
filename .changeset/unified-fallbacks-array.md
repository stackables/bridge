---
"@stackables/bridge-core": minor
"@stackables/bridge-parser": minor
"@stackables/bridge-compiler": minor
"@stackables/bridge": minor
---

Migrate wire shape from separate `falsyFallback*`/`nullishFallback*` properties to a unified `fallbacks: WireFallback[]` array, enabling mixed `||` and `??` chains in any order (e.g. `A ?? B || C ?? D`).
