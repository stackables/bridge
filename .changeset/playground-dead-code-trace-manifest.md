---
"@stackables/bridge": patch
"@stackables/bridge-core": patch
---

Bridge Trace IDs - The engine now returns a compact Trace ID alongside your data (e.g., 0x2a). This ID can be decoded into an exact execution map showing precisely which wires, fallbacks, and conditions activated. Because every bridge has a finite number of execution paths, these IDs are perfect for zero-PII monitoring and bucketing telemetry data.
