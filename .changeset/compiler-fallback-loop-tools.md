---
"@stackables/bridge": patch
"@stackables/bridge-core": patch
"@stackables/bridge-compiler": patch
"@stackables/bridge-parser": patch
---

Add memoized tool handles with compiler fallback.

Bridge `with` declarations now support `memoize` for tool handles, including
loop-scoped tool handles inside array mappings. Memoized handles reuse the same
result for repeated calls with identical inputs, and each declared handle keeps
its own cache.

The AOT compiler does not compile memoized tool handles yet. It now throws a
dedicated incompatibility error for those bridges, and compiler `executeBridge`
automatically falls back to the core ExecutionTree interpreter.
