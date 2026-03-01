---
"@stackables/bridge-core": patch
---

Performance: cache per-document work in a module-scoped `WeakMap<BridgeDocument, DocumentIndex>` to eliminate redundant computation across shadow trees.

- **Wire scanning O(N) → O(1):** wires are pre-indexed by target trunk key at document-index time; all `schedule()`, `response()`, `pullOutputField()`, `collectOutput()`, `run()`, and related methods now do a single `Map.get()` instead of a full `Array.filter()` scan on every call.
- **Constructor burn eliminated:** `JSON.parse` of `const` definitions, bridge lookup, handle-version maps, and pipe-handle maps were previously recomputed on every `shadow()` call. For a result set of N rows these were each executed N times per request; they are now computed exactly once per document.
- **Tool-def cache shared across trees:** the merged `ToolDef` extends-chain cache (`toolDefCache`) was previously per-instance, so every shadow tree started cold. It now lives on the `DocumentIndex` and is shared across all `ExecutionTree` instances backed by the same document.
