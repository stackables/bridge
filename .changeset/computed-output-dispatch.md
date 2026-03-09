---
"@stackables/bridge": patch
"@stackables/bridge-core": patch
"@stackables/bridge-parser": patch
"@stackables/bridge-compiler": patch
---

Bridge output array mappings now support computed root dispatch indices such as `o[item.index] <- source[] as item { ... }`. Runtime execution, streaming patches, serialization, and compiled execution all preserve the computed slot so mapped items land at the intended output positions.
