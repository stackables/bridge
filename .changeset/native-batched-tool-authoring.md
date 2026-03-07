---
"@stackables/bridge": minor
"@stackables/bridge-core": minor
"@stackables/bridge-types": minor
---

Improve native batched tool authoring by documenting the feature, exporting dedicated batch tool types, and simplifying the batch contract to plain input arrays.

Batch tools now receive `Input[]` and must return `Output[]` in matching order. Batched tool tracing and logging are also emitted once per flushed batch call instead of once per queued item.
