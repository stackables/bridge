---
"@stackables/bridge-core": patch
---

Fix sub-field array mapping not renaming element fields in `executeBridge` and GraphQL `JSONObject` output.

When an array mapping was used on a sub-field (e.g. `o.entries <- src.items[] as item { .id <- item.item_id }`), the engine returned the raw source array without applying element-level field renames. Root-level array bridges (`o <- src[] as item { ... }`) were unaffected.