# The Bridge Language — Definitive Guide

> Version 2.0 &middot; Last updated: February 2026

The Bridge is a declarative dataflow language that wires GraphQL fields to data
sources — APIs, transforms, constants, and other tools. You describe **what**
data goes **where**; the engine figures out **when** and **how** to fetch it.

This document is the single source of truth for Bridge language semantics. It
covers syntax, execution model, and the cost-aware resolution strategy that
keeps your API bill sane.

---

## Table of Contents

1. [File Structure](#1-file-structure)
2. [Bridge Blocks](#2-bridge-blocks)
3. [Tool Blocks](#3-tool-blocks)
4. [Const Blocks](#4-const-blocks)
5. [Define Blocks](#5-define-blocks)
6. [Wires — The Core Primitive](#6-wires--the-core-primitive)
7. [Fallback Chains: `||` and `??`](#7-fallback-chains--and-)
8. [Overdefinition — Multiple Wires to the Same Target](#8-overdefinition--multiple-wires-to-the-same-target)
9. [Execution Model](#9-execution-model)
10. [Array Mapping](#10-array-mapping)
11. [Pipe Operator](#11-pipe-operator)
12. [Tool Inheritance](#12-tool-inheritance)
13. [Force Wires (`<-!`)](#13-force-wires--)
14. [Built-in Tools](#14-built-in-tools)

---

## 1. File Structure

A `.bridge` file starts with a version declaration and contains one or more
blocks:

```bridge
version 1.4

const defaultCurrency = "EUR"

tool hereGeo from httpCall {
  .baseUrl = "https://geocode.search.hereapi.com/v1"
  .method = GET
  .path = /geocode
}

bridge Query.getWeather {
  with hereGeo as geo
  with input as i
  with output as o

  geo.q <- i.cityName
  o.lat <- geo.items[0].position.lat
  o.lon <- geo.items[0].position.lng
}
```

Blocks are separated by blank lines. Comments start with `#`.

---

## 2. Bridge Blocks

A bridge block wires a single GraphQL field to its data sources.

```bridge
bridge Query.fieldName {
  with <tool-or-source> as <handle>
  ...
  <wires>
}
```

### Handle declarations

Every reference in the wire body must go through a declared handle:

| Declaration | What it provides |
|---|---|
| `with myTool as t` | Named tool — `t.field` reads tool output |
| `with input as i` | GraphQL arguments — `i.argName` |
| `with output as o` | GraphQL return type — `o.fieldName` is the wire target |
| `with context as ctx` | Server context (auth tokens, config, etc.) |
| `with const as c` | Named constants declared in the file |
| `with myDefine as d` | A reusable define block (macro) |

### Passthrough shorthand

When a tool's output shape matches the GraphQL type exactly:

```bridge
bridge Query.rawData with myTool
```

This skips all wiring — every field on the return type is pulled directly from
the tool result.

---

## 3. Tool Blocks

Tool blocks configure reusable API call templates.

```bridge
tool hereGeo from httpCall {
  with context
  .baseUrl = "https://geocode.search.hereapi.com/v1"
  .method = GET
  .path = /geocode
  .headers.apiKey <- context.hereApiKey
}
```

### Constant wires (`.target = value`)

Set a fixed string value on the tool's input object:

```bridge
.baseUrl = "https://api.example.com"
.method = POST
```

### Pull wires (`.target <- source`)

Pull a value from a dependency at call time:

```bridge
.headers.Authorization <- context.token
.userId <- auth.sub
```

### Dependencies (`with`)

Tool blocks declare their own dependencies:

```bridge
tool secured from httpCall {
  with context                    # brings GraphQL context
  with authService as auth        # brings another tool's output
  with const                      # brings named constants
  .headers.token <- context.jwt
  .baseUrl <- const.apiBaseUrl
}
```

### Error fallback (`on error`)

Provides a fallback value when the tool call throws:

```bridge
tool fragileApi from httpCall {
  .baseUrl = "https://unstable.example.com"
  on error = { "lat": 0, "lon": 0 }
}
```

Or pull the fallback from context:

```bridge
  on error <- context.fallbacks.geo
```

---

## 4. Const Blocks

Named constants available across all bridges and tools in the file:

```bridge
const fallbackGeo = { "lat": 0, "lon": 0 }
const defaultCurrency = "EUR"
const maxRetries = 3
```

Values are JSON. Multi-line objects and arrays are supported:

```bridge
const config = {
  "timeout": 5000,
  "retries": 3
}
```

Access constants via `with const as c`, then `c.fallbackGeo.lat`.

---

## 5. Define Blocks

Defines are reusable subgraphs — think of them as macros that get inlined into
the bridge at parse time:

```bridge
define secureProfile {
  with userApi as api
  with input as i
  with output as o

  api.id <- i.userId
  o.name <- api.login
  o.email <- api.email
}
```

Use in a bridge:

```bridge
bridge Query.me {
  with secureProfile as profile
  with input as i
  with output as o

  profile.userId <- i.id
  o.name <- profile.name
}
```

---

## 6. Wires — The Core Primitive

Wires are the fundamental building block. Every wire has a **target** (left
side) and a **source** (right side), connected by `<-`:

```bridge
target <- source
```

The engine is **pull-based**: when GraphQL demands a field, the engine traces
backward through wires to find and resolve the data.

### Constant wires

```bridge
o.country = "Germany"
```

Set a fixed value. Constants always win over pull wires — if both exist for the
same target, the constant is returned immediately without triggering any tool
calls.

### Pull wires

```bridge
o.city <- geo.items[0].name
```

Resolve the source at runtime. If the source is a tool, the engine schedules
the tool call, waits for the result, and drills into the response path.

---

## 7. Fallback Chains: `||` and `??`

Bridge supports two fallback operators for building resilient data pipelines.

### `||` — Null coalesce (value guard)

Fires when the source resolves successfully but returns `null` or `undefined`.

```bridge
o.name <- api.name || "Anonymous"
```

**Execution:** The engine evaluates sources **left to right, sequentially**. It
stops at the first non-null result. Sources to the right of the winner are
**never called**.

```bridge
# If primaryApi returns non-null → done. backupApi is never called.
# If primaryApi returns null → try backupApi.
# If both return null → use "unknown".
o.label <- primaryApi.label || backupApi.label || "unknown"
```

This is critical for cost control. If `primaryApi` succeeds, the engine does
not waste a network call on `backupApi`.

**Important:** `||` does **not** catch errors. If `primaryApi` throws, the
entire chain throws (unless you also add `??`).

### `??` — Error coalesce (error guard)

Fires when the source throws an error (network failure, 500, timeout, etc.).

```bridge
o.lat <- api.lat ?? 0
o.label <- api.label ?? i.fallbackLabel
```

The `??` tail is evaluated only when everything before it throws.

### Combined chains

You can combine both operators in a single wire:

```bridge
o.label <- api.label || backup.label || "default" ?? i.errorFallback
```

Reading order:
1. Try `api.label` — if non-null, return it.
2. Try `backup.label` — if non-null, return it.
3. Both null? Return `"default"`.
4. Any of the above threw? Return `i.errorFallback`.

The `??` guard wraps the entire `||` chain. If *any* source throws during
sequential evaluation, the engine jumps to the `??` fallback.

### Pipe transforms in fallbacks

You can apply a pipe transform to the `??` fallback:

```bridge
o.label <- api.label ?? upperCase:i.errorDefault
```

If `api` throws, the engine takes `i.errorDefault` and passes it through the
`upperCase` tool before returning it.

---

## 8. Overdefinition — Multiple Wires to the Same Target

You can wire the same output field from multiple **separate lines**:

```bridge
o.textPart <- i.textBody
o.textPart <- upperCase:i.htmlBody
```

This is called **overdefinition**. When multiple wires target the same field,
they form an implicit coalesce group.

### Cost-aware resolution

The engine does not blindly race all sources. Instead, it sorts them by
**estimated cost** and evaluates them cheapest-first:

| Cost tier | Sources | Why |
|---|---|---|
| **Free** (0) | `input`, `context`, `const` | Pure memory reads, no I/O |
| **Computed** (1) | Tool calls, pipes, defines | Require scheduling and possible network I/O |

The engine:
1. Sorts the wires by cost tier (free sources first).
2. Evaluates them sequentially.
3. Returns the first non-null result.
4. Never calls expensive sources if a cheap one already has data.

**Example:**

```bridge
o.city <- i.city            # Cost 0: free (direct input read)
o.city <- geo.cityName      # Cost 1: expensive (HTTP geocoding call)
```

If the user provided `city` in the GraphQL arguments, the engine returns it
immediately. The geocoding API is never called.

This is the same short-circuit behavior as `||`, but determined by the engine
automatically based on source cost rather than by the order you wrote the
wires.

### When to use overdefinition vs `||`

| Pattern | Use when... |
|---|---|
| `o.x <- a.x \|\| b.x` | You want explicit priority: try A, then B |
| Two lines: `o.x <- cheap` / `o.x <- expensive` | The engine should pick the cheapest available source |

For overdefinition, **wire order in the file does not matter** — the engine
always evaluates cheapest first. For `||` chains, **order matters** — the
engine follows your declared priority left to right.

---

## 9. Execution Model

### Pull-based resolution

The engine is demand-driven. When GraphQL asks for a field:

1. **Match** — find wires whose target matches the requested field.
2. **Resolve** — trace backward through the wire's source.
3. **Schedule** — if the source is a tool, schedule the tool call (building
   its input from tool wires + bridge wires).
4. **Cache** — tool results are cached per request. The same tool is never
   called twice within a single GraphQL operation.

### Concurrency model

- **Independent targets** run concurrently. If a bridge requests `o.lat` and
  `o.name` from different tools, both tool calls happen in parallel.
- **Same-target wires** (overdefinition or `||` chains) run **sequentially**
  with short-circuit. The engine stops as soon as it finds data.
- **Tool input wires** run concurrently. A tool's `.param1 <- source1` and
  `.param2 <- source2` are resolved in parallel before the tool is called.

### Shadow trees (array elements)

When a wire maps an array (see [Array Mapping](#10-array-mapping)), the engine
creates a **shadow tree** for each element. A shadow tree inherits its parent's
state and context through a scope chain — you can nest arrays arbitrarily deep.

---

## 10. Array Mapping

Map each element of an array individually:

```bridge
o.journeys <- router.journeys[] as j {
  .label <- j.label
  .departureTime <- j.departure
}
```

The `[] as j { }` syntax:
1. Takes the array from `router.journeys`.
2. Creates a shadow scope for each element, bound to `j`.
3. Maps each element's fields according to the inner wires.

### Passthrough inner arrays

If an inner array's shape already matches the GraphQL type, skip explicit
field mapping:

```bridge
o.journeys <- router.journeys[] as j {
  .label <- j.label
  .stops <- j.stops          # ← passthrough: stops array used as-is
}
```

The engine automatically resolves the scalar fields of each stop from the
element data — no nested `[] as` block required.

### Note on array indices

Explicit array indices on the **target** side are not supported:

```bridge
# This will throw a parse error:
o.items[0].name <- api.firstName
```

Use array mapping blocks instead. Indices on the **source** side are fine:

```bridge
o.name <- api.results[0].name     # ← OK: reading first element from source
```

---

## 11. Pipe Operator

Route data through a transform tool inline:

```bridge
o.name <- upperCase:api.rawName
```

This is syntactic sugar for: "take `api.rawName`, pass it through `upperCase`,
wire the result to `o.name`."

### Chained pipes

```bridge
o.name <- trim:upperCase:api.rawName
```

Pipes evaluate right to left: `rawName → upperCase → trim → o.name`.

### Pipe with extra parameters

If the pipe tool needs additional configuration:

```bridge
bridge Query.convert {
  with priceApi as api
  with convertCurrency as convert
  with input as i
  with output as o

  convert.currency <- i.targetCurrency
  o.price <- convert:api.rawPrice
}
```

The `convert` tool receives both the piped value and the `currency` parameter.

---

## 12. Tool Inheritance

Tools can extend other tools to override or add wires:

```bridge
tool baseApi from httpCall {
  with context
  .baseUrl = "https://api.example.com"
  .headers.Authorization <- context.token
}

tool baseApi.users from baseApi {
  .path = /users
  .method = GET
}

tool baseApi.createUser from baseApi {
  .path = /users
  .method = POST
}
```

### Merge rules

When a child extends a parent:

1. **Function** — inherited from the root ancestor.
2. **Dependencies** — merged (child can add new deps; duplicates by handle are
   deduped).
3. **Wires** — child overrides parent wires with the same target. The child's
   wire completely replaces the parent's wire for that target key. All other
   parent wires are inherited as-is.

---

## 13. Force Wires (`<-!`)

Force wires trigger tool execution eagerly, even if the output field is never
requested by the GraphQL query:

```bridge
o.auditId <-! auditLog.id
```

Use for side effects (logging, analytics, cache warming). The tool is scheduled
immediately when the bridge starts, not when the field is demanded.

---

## 14. Built-in Tools

The `std` namespace provides built-in transform tools:

| Tool | Description |
|---|---|
| `upperCase` | Convert string to UPPER CASE |
| `lowerCase` | Convert string to lower case |
| `pickFirst` | Take the first element of an array |
| `toArray` | Wrap a value in an array |
| `findObject` | Find an object in an array by key/value |

These are available without explicit registration and can be used as pipe
transforms:

```bridge
o.name <- upperCase:api.name
o.first <- pickFirst:api.results
```

The `httpCall` tool is registered separately and provides HTTP client
functionality with configurable method, headers, path, query parameters, and
caching.
