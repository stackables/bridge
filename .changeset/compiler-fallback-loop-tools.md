---
"@stackables/bridge": patch
"@stackables/bridge-core": patch
"@stackables/bridge-compiler": patch
"@stackables/bridge-parser": patch
---

Add memoized tool handles with compiler support.

Bridge `with` declarations now support `memoize` for tool handles, including
loop-scoped tool handles inside array mappings. Memoized handles reuse the same
result for repeated calls with identical inputs, and each declared handle keeps
its own cache.

The AOT compiler now compiles memoized tool handles too, including loop-scoped
tool handles inside array mappings. Compiled execution preserves request-scoped
caching semantics and reuses results for repeated calls with identical inputs.
