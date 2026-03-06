---
"@stackables/bridge-types": minor
"@stackables/bridge-core": minor
"@stackables/bridge-stdlib": patch
---

Add `ToolMetadata` — per-tool observability controls

Tools can now attach a `.bridge` property to declare how the engine should
instrument them, imported as `ToolMetadata` from `@stackables/bridge`.

```ts
import type { ToolMetadata } from "@stackables/bridge";

myTool.bridge = {
  trace: false, // skip OTel span for this tool
  log: {
    execution: "info", // log successful calls at info level
    errors: "error", // log failures at error level (default)
  },
} satisfies ToolMetadata;
```
