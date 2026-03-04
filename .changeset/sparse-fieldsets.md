---
"@stackables/bridge-core": minor
"@stackables/bridge-compiler": minor
---

Add `requestedFields` option to `executeBridge()` for sparse fieldset filtering.

When provided, only the listed output fields (and their transitive tool dependencies) are resolved.
Tools that feed exclusively into unrequested fields are never called, reducing latency and upstream
bandwidth.

Supports dot-separated paths and a trailing wildcard (`["id", "price", "legs.*"]`).
