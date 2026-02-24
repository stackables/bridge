---
title: Custom Tools
description: Writing custom tools
---

You can inject your own tools into the engine. A tool is any function
`(input: object) => object | Promise<object>`.

### Gateway Mode

```typescript
import { bridgeTransform, parseBridge } from "@stackables/bridge";

const schema = bridgeTransform(createSchema({ typeDefs }), instructions, {
  tools: {
    myCustomTool: (input) => ({ result: input.value * 2 }),
    geocoder: async (input) => await geocodeService.lookup(input.q),
  },
});
// std.str.toUpperCase, std.str.toLowerCase, httpCall, etc. are still available
```

### Standalone Mode

```typescript
import { executeBridge, parseBridge } from "@stackables/bridge";

const instructions = parseBridge(bridgeText);
const { data } = await executeBridge({
  instructions,
  operation: "Query.myField",
  input: { city: "Berlin" },
  tools: {
    myCustomTool: (input) => ({ result: input.value * 2 }),
  },
});
```

### Overriding `std` Tools

To replace a built-in tool, override the `std` namespace (shallow merge):

```typescript
import { bridgeTransform, std } from "@stackables/bridge";

const schema = bridgeTransform(createSchema({ typeDefs }), instructions, {
  tools: {
    std: { ...std, upperCase: myCustomUpperCase },
  },
});
```
