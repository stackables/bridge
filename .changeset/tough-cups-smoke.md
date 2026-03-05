---
"@stackables/bridge": patch
"@stackables/bridge-parser": patch
---

Fix chained `||` literal fallback parsing so authored left-to-right short-circuiting is preserved after safe pulls (`?.`), and add regression coverage for mixed `||` + `??` chains.
