---
"@stackables/bridge": patch
"@stackables/bridge-core": patch
"@stackables/bridge-compiler": patch
"@stackables/bridge-parser": patch
---

Improve runtime error source mapping for ternary conditions and strict path traversal.

Runtime and compiled execution now preserve clause-level source spans for ternary conditions and branches, so formatted errors can highlight only the failing condition or selected branch instead of the whole wire.
Strict path traversal also now fails consistently on primitive property access in both runtime and AOT execution, keeping error messages and behavior aligned.
