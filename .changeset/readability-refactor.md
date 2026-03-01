---
"@stackables/bridge-core": patch
---

Readability refactoring of the execution engine (no behaviour change):

- Switched engine-internal caches on `NodeRef` and the pull-wire variant of `Wire` to symbol-keyed storage (for example, `TRUNK_KEY_CACHE` and `SIMPLE_PULL_CACHE`), eliminating `(as any)` casts that previously looked like unsafe mutations of AST nodes
- Extracted `createShadowArray()` — removes 3 identical `BREAK_SYM`/`CONTINUE_SYM`/`shadow()` loops in `pullOutputField`, `response`, and the define-field path
- Extracted `planShadowOutput()` — separates the wire-classification (planner) phase of `materializeShadows` from the execution loop, so each method has a single clear responsibility
- Extracted `evaluateWireSource()` — moves the 80-line `cond`/`condAnd`/`condOr`/`from` dispatch block out of `resolveWiresAsync`; the main loop now reads as four sequential layers: evaluate → falsy gate → nullish gate → catch
- Extracted `pullSafe()` — de-duplicates the safe-navigation `.catch()` guard shared by `condAnd` and `condOr` evaluation
