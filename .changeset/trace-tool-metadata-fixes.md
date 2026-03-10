---
"@stackables/bridge": patch
"@stackables/bridge-core": patch
"@stackables/bridge-compiler": patch
---

Tool-level tracing metadata is now applied consistently across runtime and compiled execution. Internal helpers such as string-interpolation `concat` no longer emit trace entries when their metadata sets `trace: false`, and stream tools such as `httpSSE` now produce trace entries when tracing is enabled in normal `executeBridge()` execution.
