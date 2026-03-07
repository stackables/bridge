---
"@stackables/bridge-compiler": patch
---

Compile shadowed loop-scoped tool handles in the AOT compiler.

Bridges can now redeclare the same tool alias in nested array scopes without
triggering `BridgeCompilerIncompatibleError` or falling back to the interpreter.
The compiler now assigns distinct tool instances to repeated handle bindings so
each nested scope emits and reads from the correct tool call.
