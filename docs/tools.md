# Tools & Extensions

The Bridge engine treats everything external as a "Tool" — a JavaScript function
that takes a JSON object as input and returns a JSON object (or Promise) as
output. This document covers the built-in tools, how to add your own, and
advanced configuration like response caching.

---

## Built-in Tools

The Bridge ships with built-in tools under the `std` namespace, always available
by default. All tools can be referenced with or without the `std.` prefix in
`.bridge` files.

| Tool | Input | Output | Description |
|------|-------|--------|-------------|
| `httpCall` | `{ baseUrl, method?, path?, headers?, cache?, ...fields }` | JSON response | REST API caller. GET fields → query params; POST/PUT/PATCH/DELETE → JSON body. |
| `audit` | `{ ...any, level?: string }` | passthrough (same object) | Logs all inputs via the engine logger. Level defaults to `info`. |
| `concat` | `{ parts: any[] }` | `{ value: string }` | Joins ordered parts into a string. Used internally by string interpolation. |
| `upperCase` | `{ in: string }` | `string` | Converts `in` to UPPER CASE. |
| `lowerCase` | `{ in: string }` | `string` | Converts `in` to lower case. |
| `findObject` | `{ in: any[], ...criteria }` | `object \| undefined` | Finds the first object in `in` where all criteria match. |
| `pickFirst` | `{ in: any[], strict?: bool }` | `any` | Returns the first array element. With `strict = true`, throws if the array is empty or has more than one item. |
| `toArray` | `{ in: any }` | `any[]` | Wraps a single value in an array. Returns as-is if already an array. |

The `math` namespace provides arithmetic and comparison tools, used automatically
by inline expression syntax (e.g. `o.total <- i.price * i.qty`). See the
[Language Guide — Inline Expressions](./bridge-language-guide.md#12-inline-expressions)
for details.

---

## `std.httpCall` — REST API Tool

The primary tool for calling external APIs. It builds an HTTP request from the
wired input fields and returns the parsed JSON response.

### Input Fields

| Field | Default | Description |
|-------|---------|-------------|
| `baseUrl` | `""` | Base URL for the request |
| `method` | `GET` | HTTP method |
| `path` | `""` | Appended to `baseUrl` for the full URL |
| `headers` | `{}` | HTTP headers object |
| `cache` | `"auto"` | Cache mode (see [Response Caching](#response-caching)) |
| All other fields | — | **GET:** sent as query string parameters. **POST/PUT/PATCH/DELETE:** sent as JSON body. |

### Example

```bridge
tool geo from httpCall {
  .baseUrl = "https://nominatim.openstreetmap.org"
  .method = GET
  .path = /search
  .cache = 60
  .headers.User-Agent = "MyApp/1.0"
}

bridge Query.geocode {
  with geo as g
  with input as i
  with output as o

  g.q <- i.city
  g.format = "json"
  o.lat <- g[0].lat
  o.lon <- g[0].lon
}
```

---

## Response Caching

Add a `cache` field to any `httpCall` tool to enable TTL-based response caching.
Identical requests (same method + URL + params/body) return the cached result
without hitting the network.

### Cache Modes

| Value | Behavior |
|-------|----------|
| `"auto"` (default) | Respect HTTP `Cache-Control` / `Expires` response headers |
| `0` | Disable caching entirely |
| `<seconds>` | Explicit TTL override — ignores response headers |

```bridge
tool geo from httpCall {
  .cache = 300          # cache for 5 minutes
  .baseUrl = "https://nominatim.openstreetmap.org"
  .method = GET
  .path = /search
}
```

### Custom Cache Store

The default is an in-memory LRU store (1024 entries). For Redis or other
backends, pass a custom `CacheStore` to `createHttpCall`:

```typescript
import { createHttpCall, std } from "@stackables/bridge";
import type { CacheStore } from "@stackables/bridge";

const redisCache: CacheStore = {
  async get(key) {
    return redis.get(key).then(v => v ? JSON.parse(v) : undefined);
  },
  async set(key, value, ttl) {
    await redis.set(key, JSON.stringify(value), "EX", ttl);
  },
};

// Gateway mode — replace the default httpCall with a Redis-backed one
bridgeTransform(schema, instructions, {
  tools: { std: { ...std, httpCall: createHttpCall(fetch, redisCache) } },
});
```

---

## Custom Tools

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
// std.upperCase, std.lowerCase, httpCall, etc. are still available
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

---

## `std.audit` — Side-Effect Logging

The `audit` tool logs every input it receives through the configured
[logger](./observability.md#structured-logging). Wire any number of inputs to it
and use `force` to trigger execution:

```bridge
bridge Mutation.createOrder {
  with std.audit as audit
  with orderApi as api
  with input as i
  with output as o

  api.product <- i.product
  audit.action = "createOrder"
  audit.userId <- i.userId
  audit.orderId <- api.id
  force audit

  o.id <- api.id
}
```

The tool returns its input as a passthrough, so output wires can also
read from it (e.g. `o.auditId <- audit.id`).

---

## Tool Error Handling

Each tool supports a `on error` fallback, declared inside the `tool` block.
Catches any exception thrown by the tool's function. All tools that inherit from
this tool inherit the fallback.

```bridge
tool geo from httpCall {
  .baseUrl = "https://nominatim.openstreetmap.org"
  .method = GET
  .path = /search
  on error = { "lat": 0, "lon": 0 }    # tool-level fallback
}

tool geo.v2 from geo {
  .path = /search/v2       # inherits the on error from geo
}
```

Or pull the fallback from context:

```bridge
tool geo from httpCall {
  with context
  .baseUrl = "https://geo.example.com"
  on error <- context.fallbacks.geo
}
```

For wire-level error handling (`||` and `??` operators), see the
[Language Guide — Fallback Chains](./bridge-language-guide.md#7-fallback-chains--and-).

---

## Further Reading

- **[Language Guide](./bridge-language-guide.md)** — Full syntax reference
- **[Observability](./observability.md)** — OpenTelemetry, logging, and `extensions.traces`
- **[Dynamic Routing](./dynamic-routing.md)** — Per-request topology switching
