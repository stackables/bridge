---
"@stackables/bridge-parser": patch
---

`serializeBridge` no longer writes a constant like `o.a = "{}"` or `"[]"` as a bare `{}` / `[]` that `parseBridge` rejects; it keeps the quotes.
