---
"@stackables/bridge-core": patch
"@stackables/bridge": patch
---

Add infinite loop protection to the execution engine:

- **Depth ceiling**: Shadow tree nesting is capped at 30 levels. Exceeding this limit throws a `BridgePanicError`, preventing infinite recursion from circular array mappings or deeply nested tool chains.
- **Cycle detection**: The pull chain now tracks which trunks are actively being resolved. If a trunk is encountered again in its own resolution path (e.g. Tool A → Tool B → Tool A), a `BridgePanicError` is thrown immediately instead of silently deadlocking.
