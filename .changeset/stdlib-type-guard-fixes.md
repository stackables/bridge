---
"@stackables/bridge-stdlib": patch
---

Fix `filter`, `find`, `toLowerCase`, `toUpperCase`, `trim`, and `length` crashing on unexpected input types

- `filter` and `find` now return `undefined` (instead of throwing `TypeError`) when passed a non-array `in` value, and silently skip null/non-object elements rather than crashing
- `toLowerCase`, `toUpperCase`, `trim`, and `length` now return `undefined` (instead of throwing `TypeError`) when passed a non-string value
