---
"@stackables/bridge": patch
"@stackables/bridge-compiler": patch
---

Add compiler compatibility fallback for nested loop-scoped tools.

The AOT compiler now throws a dedicated incompatibility error for bridges whose
nested array outputs depend on loop-scoped tool instances. The compiler
`executeBridge` catches that incompatibility and falls back to the core
ExecutionTree interpreter automatically.
