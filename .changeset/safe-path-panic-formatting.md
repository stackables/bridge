---
"@stackables/bridge": patch
"@stackables/bridge-core": patch
"@stackables/bridge-compiler": patch
---

Fix segment-local `?.` traversal so later strict path segments still fail after a guarded null hop, and preserve source formatting for `panic` control-flow errors.
