# The Bridge Language — Definitive Guide

> Version 2.0 &middot; Last updated: February 2026

The Bridge is a declarative dataflow language that wires GraphQL fields to data
sources — APIs, transforms, constants, and other tools. You describe **what**
data goes **where**; the engine figures out **when** and **how** to fetch it.

This document is the single source of truth for Bridge language semantics. It
covers syntax, execution model, and the cost-aware resolution strategy that
keeps your API bill sane.

**Related documentation:**
- [Tools & Extensions](./tools.md) — built-in tools, custom tools, `httpCall` configuration, and response caching
- [Observability](./observability.md) — OpenTelemetry spans & metrics, structured logging, and `extensions.traces`
- [Dynamic Routing](./dynamic-routing.md) — per-request topology switching for multi-tenant and region-aware deployments

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
12. [Inline Expressions](#12-inline-expressions)
13. [Conditional Wire (`? :`)](#13-conditional-wire--)
14. [String Interpolation](#14-string-interpolation)
15. [Tool Inheritance](#15-tool-inheritance)
16. [Force Statement (`force <handle>`)](#16-force-statement-force-handle)
17. [Built-in Tools](#17-built-in-tools)

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

### Alias Declarations (`alias ... as`)

The `alias` keyword creates a named binding that caches the result of a source
expression. It works both inside array mapping blocks and at the top level of a
bridge body.

#### Inside array mappings — evaluate once per element

When mapping over arrays, you may need to pass each element through a tool and
extract multiple fields from the result. Without aliases, this forces the engine
to execute the tool once per field — wasteful.

```bridge
o.list <- api.items[] as it {
  alias enrich:it as resp       # evaluate pipe once per element
  .a <- resp.a                  # cost-0 memory read
  .b <- resp.b                  # cost-0 memory read
}
```

The `alias enrich:it as resp` line:
1. Pipes each element through the `enrich` tool.
2. Caches the result in a local handle named `resp`.
3. Makes `resp` available to all subsequent wires in the same block.

The engine evaluates `enrich` exactly **once per element**, regardless of how
many fields pull from `resp`.

You can also bind a sub-field of the iterator directly:

```bridge
o.list <- api.items[] as it {
  alias it.metadata as m        # bind a sub-object
  .author <- m.author
  .date   <- m.createdAt
}
```

This is purely a readability convenience — it doesn't trigger any tool call.

#### At the bridge body level — rename or cache

Top-level aliases are useful for renaming deeply nested paths or caching pipe
results that are referenced by multiple wires:

```bridge
bridge Query.getUser {
  with std.httpCall as api
  with input as i
  with output as o

  api.path = "/users/1"

  # Perfect for renaming deep paths
  alias api.company.address as addr

  o.city <- addr.city
  o.state <- addr.state
}
```

When the alias wraps a pipe chain, the tool is evaluated **once** regardless of
how many wires read from the cached result:

```bridge
  alias uc:i.category as upperCat   # uc called once
  o.label <- upperCat               # free memory read
  o.title <- upperCat               # free memory read
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

## 12. Inline Expressions

Perform arithmetic and comparison operations directly in wire assignments:

```bridge
o.cents <- i.dollars * 100
o.total <- i.price * i.quantity
o.eligible <- i.age >= 18
o.isActive <- i.status == "active"
```

### Supported operators

| Category | Operators | Description |
|---|---|---|
| Arithmetic | `*` `/` `+` `-` | Multiply, divide, add, subtract |
| Comparison | `==` `!=` `>` `>=` `<` `<=` | Returns `true` or `false` |

### Operator precedence

Standard math precedence applies:

1. `*` `/` — highest precedence (evaluated first)
2. `+` `-` — medium precedence
3. `==` `!=` `>` `>=` `<` `<=` — lowest precedence (evaluated last)

```bridge
o.total <- i.base + i.tax * 2       // = i.base + (i.tax * 2)
o.flag  <- i.price * i.qty > 100    // = (i.price * i.qty) > 100
```

### Chained expressions

Multiple operators can be chained:

```bridge
o.result <- i.times * 5 / 10
o.flag   <- i.times * 2 > 6
```

### Expressions with fallbacks

Expressions work with `||` (null coalesce) and `??` (error coalesce):

```bridge
o.cents <- api.price * 100 ?? -1
```

If `api.price` throws, the `??` fallback catches the error and returns `-1`.

### Operand types

The right-hand operand of each operator can be:

- **Number literal**: `100`, `1.2`, `-5`
- **String literal**: `"active"` (for equality comparisons)
- **Boolean literal**: `true` (coerced to `1`), `false` (coerced to `0`)
- **Source reference**: `i.quantity`, `api.price`

### Non-number handling

All arithmetic operands are coerced via JavaScript `Number()`:

| Input | Coerced to | Example |
|---|---|---|
| `null` | `0` | `null * 100 = 0` |
| `undefined` | `NaN` | `undefined + 5 = NaN` |
| Numeric string | Number | `"10" * 5 = 50` |
| Non-numeric string | `NaN` | `"hello" + 1 = NaN` |

Comparison operators with `NaN` always return `false`.

### Expressions in array mapping

Expressions work inside `[] as iter { }` element blocks:

```bridge
o.items <- api.items[] as item {
  .name  <- item.name
  .cents <- item.price * 100
}
```

### How it works

Expressions are **syntactic sugar**. The parser desugars them into synthetic
tool forks using the built-in `math` namespace tools. The execution engine
never sees expression syntax — it processes standard pull and constant wires.

For example, `o.total <- i.price * i.qty` becomes:

```
Wire: i.price → math.multiply.a
Wire: i.qty   → math.multiply.b
Wire: math.multiply → o.total
```

---

## 13. Conditional Wire (`? :`)

Select between two sources based on a boolean condition. Only the chosen
branch is evaluated — the other branch is never touched.

```bridge
o.amount <- i.isPro ? i.proPrice : i.basicPrice
```

### Syntax

```
<target> <- <condition> ? <then> : <else>
```

- **`condition`** — any source reference or expression (e.g. `i.flag`, `i.age >= 18`)
- **`then`** — source reference or literal (string, number, boolean, null)
- **`else`** — source reference or literal

### Literal branches

```bridge
o.tier     <- i.isPro ? "premium" : "basic"
o.discount <- i.isPro ? 20 : 5
o.active   <- i.isPro ? true : false
```

### Expression conditions

The condition can be a full expression, including comparisons:

```bridge
o.result <- i.age >= 18 ? i.adultPrice : i.childPrice
o.flag   <- i.score * 2 > 100 ? "pass" : "fail"
```

### Combining with fallbacks

`||` (null-coalesce) and `??` (error-coalesce) can follow the ternary:

```bridge
# || fires when the chosen branch is null/undefined
o.price <- i.isPro ? i.proPrice : i.basicPrice || 0

# ?? fires when the chosen branch throws
o.price <- i.isPro ? proTool.price : basicTool.price ?? -1

# || with a source reference
o.price <- i.isPro ? i.proPrice : i.basicPrice || fallback.getPrice
```

### Inside array mapping

```bridge
o.items <- api.results[] as item {
  .name  <- item.name
  .price <- item.isPro ? item.proPrice : item.basicPrice
}
```

### Semantics

The engine evaluates the **condition first** (benefiting from the cost-0
fast-path for input/context reads). It then pulls **only the chosen branch**
— the other branch is never scheduled, preventing unnecessary tool calls.

---

## 14. String Interpolation

String interpolation lets you build strings from multiple sources using `{…}`
placeholders inside quoted strings on the right-hand side of a pull wire (`<-`).

```bridge
bridge Query.userOrders {
  with ordersApi as api
  with input as i
  with output as o

  # REST URL construction
  api.path <- "/users/{i.id}/orders"

  # Assembling display text
  o.name <- "{i.firstName} {i.lastName}"
  o.greeting <- "Hello, {i.firstName}!"
}
```

### Syntax

A string on the RHS of `<-` is scanned for `{…}` placeholders. If any are
found, the string becomes a template — the engine resolves each placeholder
at runtime and concatenates the result.

Placeholders reference the same source addresses used in regular pull wires:
`i.field`, `api.field`, `ctx.field`, alias names, etc.

```bridge
o.url     <- "/api/{api.version}/items/{i.itemId}"
o.display <- "{i.first} {i.last}"
```

### Constant wires are not interpolated

The `=` operator assigns verbatim — no interpolation:

```bridge
o.path = "/users/{id}"       # literal string, braces kept as-is
o.path <- "/users/{i.id}"    # template — {i.id} is resolved
```

### Non-string values

Placeholder values are coerced to strings at runtime:

| Source value | Interpolated as |
|---|---|
| `"hello"` | `hello` |
| `42` | `"42"` |
| `true` | `"true"` |
| `null` / `undefined` | `""` (empty string) |

### Escaping

Use `\{` to include a literal brace in a template string:

```bridge
o.json <- "\{key: {i.value}}"    # produces: {key: someValue}
```

### Inside array mapping

Template strings work inside `[] as iter { }` blocks:

```bridge
o <- api.items[] as it {
  .url   <- "/items/{it.id}"
  .label <- "{it.name} (#{it.id})"
}
```

### Combining with fallbacks

Templates support `||` (null coalesce) and `??` (error coalesce):

```bridge
o.greeting <- "Hello, {i.name}!" || "Hello, stranger!"
```

### How it works

Under the hood, the parser desugars template strings into a synthetic
`std.concat` fork — the same pattern used by pipes and inline expressions.
The engine never learns about template strings; it just resolves tool
inputs, calls `std.concat`, and wires the result to the target.

---

## 15. Tool Inheritance

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

## 16. Force Statement (`force <handle>`)

The `force` statement eagerly schedules a tool for execution, even if no output
field demands its data. Use it for side effects — audit logging, analytics,
cache warming.

A bare `force` is **critical**: if the forced tool throws, the error propagates
into the response just like a regular tool failure.

```bridge
bridge Query.search {
  with searchApi as s
  with audit.log as audit
  with input as i
  with output as o

  s.q <- i.q
  audit.action <- i.q
  force audit            # critical — error breaks the response
  force audit ?? null.   # fire-and-forget — errors are silently swallowed
  o.title <- s.title
}
```

---

## 17. Built-in Tools

### `std` namespace — Transform tools

| Tool | Description |
|---|---|
| `audit` | Log all inputs via the configured logger |
| `concat` | Join ordered parts into a single string (used by string interpolation) |
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

### `std.audit` — Side-effect logging tool

The `audit` tool logs every input it receives through the configured logger. Wire any number of inputs to it and force the handle:

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

The tool returns its input as a passthrough, so output wires *can* read from
it (e.g. `o.auditId <- audit.id`)

### `math` namespace — Math and comparison tools

| Tool | Description |
|---|---|
| `multiply` | Multiply two numbers (`a * b`) |
| `divide` | Divide two numbers (`a / b`) |
| `add` | Add two numbers (`a + b`) |
| `subtract` | Subtract two numbers (`a - b`) |
| `eq` | Strict equality (`a === b`), returns `true` or `false` |
| `neq` | Strict inequality (`a !== b`), returns `true` or `false` |
| `gt` | Greater than (`a > b`), returns `true` or `false` |
| `gte` | Greater than or equal (`a >= b`), returns `true` or `false` |
| `lt` | Less than (`a < b`), returns `true` or `false` |
| `lte` | Less than or equal (`a <= b`), returns `true` or `false` |

The `math` tools are used automatically by inline expression syntax
(see [Section 12](#12-inline-expressions)). They can also be used
explicitly as pipe transforms.

```bridge
o.name <- upperCase:api.name
o.first <- pickFirst:api.results
```

The `httpCall` tool is registered separately and provides HTTP client
functionality with configurable method, headers, path, query parameters, and
caching.

👉 **[Read the Tools & Extensions Guide](./tools.md)** for full `httpCall`
documentation, response caching configuration, custom cache stores, and how
to inject your own tools into the engine.
