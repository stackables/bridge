---
"@stackables/bridge-compiler": patch
---

Fix AOT compiler to throw `BridgeTimeoutError` on tool timeout

AOT-compiled bridges now throw `BridgeTimeoutError` (with the same name and
message format as the runtime) when a tool exceeds `toolTimeoutMs`. Previously
the generated code constructed a generic `Error`, causing a class mismatch when
callers caught and inspected the error type.
