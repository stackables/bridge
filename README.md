[![npm](https://img.shields.io/npm/v/@stackables/bridge?label=@stackables/bridge&logo=npm)](https://www.npmjs.com/package/@stackables/bridge)
[![extension](https://img.shields.io/badge/VS_Code-LSP-blue)](https://marketplace.visualstudio.com/items?itemName=stackables.bridge-syntax-highlight)
[![roadmap](https://img.shields.io/badge/Roadmap-green)](./docs/roadmap.md)

# The Bridge

**Declarative dataflow for GraphQL.**
Wire data between APIs, tools, and fields using `.bridge` files—no resolvers, no codegen, no plumbing.

```bash
npm install @stackables/bridge
```

> **Developer Preview**
> The Bridge v1.x is a public preview and is not recommended for production use.
>
> * Stability: Breaking changes to the .bridge language and TypeScript API will occur frequently.
> * Versioning: We follow strict SemVer starting from v2.0.0.
>
> Feedback: We are actively looking for use cases. Please share yours in our GitHub Discussions.

---

## The Idea

Most GraphQL backends are just plumbing: take input, call an API, rename fields, and return. **The Bridge** turns that manual labor into a declarative graph of intent.

Every .bridge file maps GraphQL schema fields to tools and external APIs.

The engine resolves **backwards from demand**: when a GraphQL query requests `results[0].lat`, the engine traces the wire back to the `position.lat` of a specific API response. Only the data required to satisfy the query is ever fetched or executed.

### What it is (and isn't)

The Bridge is a **Smart Mapping Outgoing Proxy**, not a replacement for your application logic.

* **Use it to:** Morph external API shapes, enforce single exit points for security, and swap providers (e.g., SendGrid to Postmark) without changing app code.
* **Don't use it for:** Complex business logic or database transactions. Keep the "intelligence" in your Tools; keep the "connectivity" in your Bridge.
* Bridge is a declarative dataflow layer for GraphQL, **not a standalone API.**

### Wiring, not Programming

The Bridge is not a programming language. It is a Data Topology Language.

Unlike Python or JavaScript, where you write a list of instructions for a computer to execute in order, a .bridge file describes a static circuit. There is no "execution pointer" that moves from the top of the file to the bottom.

No Sequential Logic: Shuffling the lines inside a define or bridge block changes nothing. The engine doesn't "run" your file; it uses your file to understand how your GraphQL fields are physically wired to your tools.

Pull, Don't Push: In a normal language, you "push" data into variables. In The Bridge, the GraphQL query "pulls" data through the wires. If a client doesn't ask for a field, the wire is "dead"—no code runs, and no API is called.

Declarative Connections: When you write o.name <- api.name, you aren't commanding a copy operation; you are soldering a permanent link between two points in your graph.

**Don't think in scripts. Think in schematics.**

### Portability & Performance

While the reference engine is implemented in TypeScript, the Bridge language itself is a simple, high-level specification for data flow. Because it describes intent rather than execution, it is architecturally "runtime-blind." It can be interpreted by any high-performance engines written in Rust, Go, or C++ without changing a single line of your .bridge files.

### Usage with LLMs

The Bridge language is deliberately designed to be simple for LLMs to generate and visually easy for humans to review. It supports inline documentation and works well with Git or other source control systems.

Most of the time, it’s enough to give your LLM this README and the GraphQL schema file. Based on that, the LLM can generate the mapping for any API it knows. For non-public or undocumented APIs, you should provide the LLM with the JSON schema or API documentation to avoid hallucinations.

---

## The Workflow

The Bridge doesn't replace your GraphQL schema; it implements it. You define your **Types** in standard GraphQL SDL, then use `.bridge` files to wire those types to your data sources.

### 1. Define your Schema

Start with a standard `schema.graphql` file. This is your "Interface."

```graphql
type Location {
  lat: Float
  lon: Float
}

type Query {
  location(city: String!): Location
}

```

### 2. Wire the Bridge

Create your `logic.bridge` file to implement the resolver for that specific field. This is your "Implementation."

```hcl
version 1.4

tool geo from httpCall {
  .baseUrl = "https://nominatim.openstreetmap.org"
  .path = "/search"
}

bridge Query.location {
  with geo
  with input as i
  with output as o

  # 'i.city' comes from the GraphQL argument
  # 'o.lat' maps to the 'lat' field in the Location type
  geo.q <- i.city
  o.lat <- geo[0].lat
  o.lon <- geo[0].lon
}
```

### 3. Initialize the Engine

The Bridge takes your existing schema and automatically attaches the logic.

```typescript
import { bridgeTransform, parseBridge } from "@stackables/bridge";
import { createSchema } from "graphql-yoga";

const typeDefs = /* load your schema.graphql */;
const bridgeFile = /* load your logic.bridge */;

const schema = bridgeTransform(
  createSchema({ typeDefs }), 
  parseBridge(bridgeFile)
);

```

---

## The Language

Get syntax highlighting for [Visual Studio Code](https://marketplace.visualstudio.com/items?itemName=stackables.bridge-syntax-highlight).

[Full language guide](./docs//bridge-language-guide.md)

Every `.bridge` file must begin with a version declaration.

```hcl
version 1.4
```

This is the first non-blank, non-comment line. Everything else follows after it.

### 1. Const Blocks (`const`)

Named JSON values reusable across tools and bridges. Avoids repetition for fallback payloads, defaults, and config fragments.

```hcl
const fallbackGeo = { "lat": 0, "lon": 0 }
const defaultCurrency = "EUR"
const maxRetries = 3
```

Access const values in bridges or tools via `with const as c`, then reference as `c.<name>.<path>`.

### 2. Tool Blocks (`tool ... from`)

Defines the "Where" and the "How." Takes a function (or parent tool) and configures it, giving it a new name.

```hcl
tool <name> from <source> {
  [with context]                  # Injects GraphQL context (auth, secrets, etc.)
  [on error = <json_fallback>]    # Fallback value if tool fails
  [on error <- <source>]          # Pull fallback from context/tool

  .<param> = <value>              # Constant/Default value (dot = "this tool's param")
  .<param> <- <source>            # Dynamic wire
}
```

Param lines use a `.` prefix — the dot means "this tool's own field". `with` and `on error` lines do not use a dot; they are control flow, not param assignments.

When `<source>` is a function name (e.g. `httpCall`), a new tool is created.
When `<source>` is an existing tool name, the new tool inherits its configuration.

### 3. Define Blocks (`define`)

Reusable named subgraphs — compose tools and wires into a pipeline, then invoke it from any bridge.

```hcl
define <name> {
  with <tool> as <handle>     # Tools used inside the pipeline
  with input as <handle>      # Inputs provided by the caller
  with output as <handle>     # Outputs returned to the caller

  <handle>.<param> <- <source>  # Wiring (same syntax as bridge)
  <handle>.<param> = <value>    # Constants
}
```

Use a define in a bridge with `with <define> as <handle>`:

```hcl
define geocode {
  with std.httpCall as geo
  with input as i
  with output as o

  geo.baseUrl = "https://nominatim.openstreetmap.org"
  geo.method = GET
  geo.path = /search
  geo.q <- i.city
  o.lat <- geo[0].lat
  o.lon <- geo[0].lon
}

bridge Query.location {
  with geocode as g
  with input as i
  with output as o

  g.city <- i.city
  o.lat <- g.lat
  o.lon <- g.lon
}
```

Each invocation is fully isolated — calling the same define twice creates independent tool instances with no namespace collisions.

### 4. Bridge Blocks (`bridge`)

The resolver logic connecting GraphQL schema fields to your tools.

```hcl
bridge <Type.field> {
  with <tool> [as <alias>]
  with input as i
  with output as o

  # Field Mapping
  o.<field> = <json>                    # Constant output value
  o.<field> <- <source>                 # Standard Pull (lazy)
  o.<field> <-! <source>               # Forced Push (eager/side-effect)

  # Pipe chain (tool transformation)
  o.<field> <- handle:source            # Route source through tool handle

  # Fallbacks
  o.<field> <- <source> || <alt> || <alt> # Null-coalesce: use alt if source is null
  o.<field> <- <source> ?? <fallback>     # Error-fallback: use fallback if chain throws

  # Array Mapping (brace block per element)
  o.<field> <- <source>[] as <iter> {
    .<sub_field> <- <iter>.<sub_src>    # Element field via iterator
    .<sub_field> = "constant"           # Element constant
  }
}
```

Bridge can be fully implemented in the defined pipeline.

```
define namedOperation {
  ....
}

bridge <Type.field> with namedOperation
```

---

## Key Features

### Reserved Words

**Keywords** — cannot be used as tool names, handle aliases, or const names:

> `bridge` `with` `as` `from` `const` `tool` `version` `define`

**Source identifiers** — reserved for their specific role inside `bridge` and `tool` blocks:

> `input` `output` `context`

A parse error is thrown immediately if any of these appear where a user-defined name is expected.

### Scope Rules

Bridge uses explicit scoping. Any entity referenced inside a `bridge` or `tool` block must first be introduced into scope using a `with` clause.

This includes:

* `tools`
* `input`
* `output`
* `context`
* `tool aliases`

The `input` and `output` handles represents GraphQL field arguments and output type. They exists **only inside `bridge` blocks**.

Because `tool` blocks are evaluated before any GraphQL execution occurs, they cannot reference `input` or `output`.

> **Rule of thumb:**
> `tool ... from` defines tools, `bridge` executes the graph.
> Since `input` and `output` belong to GraphQL execution, they only exist inside bridges.

### Resiliency

Each layer handles a different failure mode. They compose freely.

#### Layer 1 — Tool `on error` (execution errors)

Declared inside the `tool` block. Catches any exception thrown by the tool's `fn(input)`. All tools that inherit from this tool inherit the fallback.

```hcl
tool geo from httpCall {
  .baseUrl = "https://nominatim.openstreetmap.org"
  .method = GET
  .path = /search
  on error = { "lat": 0, "lon": 0 }   # tool-level default
}
```

#### Layer 2 — Wire `||` (null / absent values)

Fires when a source resolves **successfully but returns `null` or `undefined`**. The fallback can be a JSON literal or another source expression (handle path or pipe chain). Multiple `||` alternatives chain left-to-right like `COALESCE`.

```hcl
with output as o

# JSON literal fallback
o.lat <- geo.lat || 0.0

# Alternative source fallback
o.label <- api.label || backup.label || "unknown"

# Pipe chain as alternative
o.textPart <- i.textBody || convert:i.htmlBody || "empty"
```

#### Layer 3 — Wire `??` (errors and exceptions)

Fires when the **entire resolution chain throws** (network failure, tool down, dependency error). Does not fire on null values — that's `||`'s job. The fallback can be a JSON literal or a source/pipe expression (evaluated lazily, only when the error fires).

```hcl
with output as o

# JSON literal error fallback
o.lat <- geo.lat ?? 0.0

# Error fallback pulls from another source
o.label <- api.label ?? errorHandler:i.fallbackMsg
```

#### Full COALESCE — composing all three layers

`||` and `??` compose into a Postgres-style `COALESCE` with an error guard at the end:

```hcl
with output as o

# o.label <- A || B || C || "literal" ?? errorSource
o.label <- api.label || tool:api.backup.label || "unknown" ?? tool:const.errorString

# Evaluation order:
# api.label non-null     → use it immediately
# api.label null         → try toolIfNeeded(api.backup.label)
# that null              → "unknown"  (|| json literal always succeeds)
# any source throws      → toolIfNeeded(const.errorString)  (?? fires last)
```

Multiple `||` sources desugar to **parallel wires** — all sources are evaluated concurrently and the first that resolves to a non-null value wins. Cheaper/faster sources (like `input` fields) naturally win without any priority hints.

### Forced Wires (`<-!`)

By default, the engine is **lazy**. Use `<-!` to force execution regardless of demand—perfect for side-effects like analytics, audit logging, or cache warming.

```hcl
bridge Mutation.updateUser {
  with audit.logger as log
  with input as in
  with output as out

  # 'log' runs even if the client doesn't query the 'status' field
  out.status <-! log:in.changeData
}
```

### The Pipe Operator (`:`)

Routes data right-to-left through one or more tool handles: `dest <- handle:source`.

```hcl
with output as o

# i.rawData → normalize → transform → result
o.result <- transform:normalize:i.rawData
```

Full example with a tool that has 2 input parameters:

```hcl
tool convert from currencyConverter {
  .currency = EUR   # default currency
}

# example with pipe syntax
bridge Query.price {
  with convert as c
  with input as i
  with output as o

  c.currency <- i.currency   # overrides the default per request

  # Safe to use repeatedly — each is an independent tool call
  o.itemPrice  <- c:i.itemPrice
  o.totalPrice <- c:i.totalPrice
}

# same without the pipe syntax
tool c1 from convert
tool c2 from convert

bridge Query.price {
  with c1
  with c2
  with input as i
  with output as o

  c1.currency <- i.currency   # overrides the default per request
  c2.currency <- i.currency   # overrides the default per request

  c1.in <- i.itemPrice
  c2.in <- i.totalPrice

  # Safe to use repeatedly — each is an independent tool call
  o.itemPrice  <- c1
  o.totalPrice <- c2
}
```

---

## Syntax Reference

| Operator | Type | Behavior |
| --- | --- | --- |
| **`=`** | Constant | Sets a static value. |
| **`<-`** | Wire | Pulls data from a source at runtime. |
| **`<-!`** | Force | Eagerly schedules a tool (for side-effects). |
| **`:`** | Pipe | Chains data through tools right-to-left. |
| **`\|\|`** | Null-coalesce | Next alternative if current source is `null`/`undefined`. Fires on absent values, not errors. |
| **`??`** | Error-fallback | Alternative used when the resolution chain **throws**. Fires on errors, not null values. |
| **`on error`** | Tool Fallback | Returns a default if the tool's `fn(input)` throws. |
| **`tool ... from`** | Tool Definition | Configures a function or inherits from a parent tool. |
| **`define`** | Reusable Subgraph | Declares a named pipeline template invocable from bridges. |
| **`const`** | Named Value | Declares reusable JSON constants. |
| **`<- src[] as i { }`** | Map | Iterates over source array; each element accessed via the named iterator `i`. `i.field` references the current element. `.field = "value"` sets an element constant. |

---

## Usage

### 1. Basic Setup

The Bridge wraps your existing GraphQL schema, handling the `resolve` functions automatically.

```typescript
import { createSchema, createYoga } from "graphql-yoga";
import { bridgeTransform, parseBridge } from "@stackables/bridge";

const schema = bridgeTransform(
  createSchema({ typeDefs }), 
  parseBridge(bridgeFileText)
);

const yoga = createYoga({
  schema,
  context: () => ({
    api: { key: process.env.API_KEY },
  }),
});

```

### 2. Custom Tools

```typescript
const schema = bridgeTransform(createSchema({ typeDefs }), instructions, {
  tools: {
    toCents: ({ in: dollars }) => ({ cents: dollars * 100 }),
  },
});

```

---

## Built-in Tools

The Bridge ships with built-in tools under the `std` namespace, always available by default. All tools (including `httpCall`) live under `std` and can be referenced with or without the `std.` prefix.

| Tool | Input | Output | Description |
| --- | --- | --- | --- |
| `httpCall` | `{ baseUrl, method?, path?, headers?, cache?, ...fields }` | JSON response | REST API caller. GET fields → query params; POST/PUT/PATCH/DELETE → JSON body. `cache` = TTL in seconds (0 = off). |
| `upperCase` | `{ in: string }` | `string` | Converts `in` to UPPER CASE. |
| `lowerCase` | `{ in: string }` | `string` | Converts `in` to lower case. |
| `findObject` | `{ in: any[], ...criteria }` | `object \| undefined` | Finds the first object in `in` where all criteria match. |
| `pickFirst` | `{ in: any[], strict?: bool }` | `any` | Returns the first array element. With `strict = true`, throws if the array is empty or has more than one item. |
| `toArray` | `{ in: any }` | `any[]` | Wraps a single value in an array. Returns as-is if already an array. |

### Adding Custom Tools

```typescript
import { bridgeTransform } from "@stackables/bridge";

const schema = bridgeTransform(createSchema({ typeDefs }), instructions, {
  tools: {
    myCustomTool: (input) => ({ result: input.value * 2 }),
  },
});
// std.upperCase, std.lowerCase, etc. are still available
```

To override a `std` tool, replace the namespace (shallow merge):

```typescript
import { bridgeTransform, std } from "@stackables/bridge";

const schema = bridgeTransform(createSchema({ typeDefs }), instructions, {
  tools: {
    std: { ...std, upperCase: myCustomUpperCase },
  },
});
```

### Response Caching

Add `cache = <seconds>` to any `httpCall` tool to enable TTL-based response caching. Identical requests (same method + URL + params) return the cached result without hitting the network.

```hcl
tool geo from httpCall {
  .cache = 300          # cache for 5 minutes
  .baseUrl = "https://nominatim.openstreetmap.org"
  .method = GET
  .path = /search
}
```

The default is an in-memory store. For Redis or other backends, pass a custom `CacheStore` to `createHttpCall`:

```typescript
import { createHttpCall, std } from "@stackables/bridge";
import type { CacheStore } from "@stackables/bridge";

const redisCache: CacheStore = {
  async get(key) { return redis.get(key).then(v => v ? JSON.parse(v) : undefined); },
  async set(key, value, ttl) { await redis.set(key, JSON.stringify(value), "EX", ttl); },
};

bridgeTransform(schema, instructions, {
  tools: { std: { ...std, httpCall: createHttpCall(fetch, redisCache) } },
});
```
