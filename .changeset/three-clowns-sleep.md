---
"@stackables/bridge-core": minor
---

Get syntax highlighting directly in typescript files

```typescript
import { bridge, parseBridge } from "@stackables/bridge";

const doc = parseBridge(bridge`
  version 1.5
  bridge Query.hello {
    with input as i
    with output as o
    o.message <- i.name
  }
`);
```
