# The Bridge

**Declarative dataflow for GraphQL.**
Wire data between APIs, tools, and fields using `.bridge` files—no resolvers, no codegen, no plumbing.

```bash
npm install @stackables/bridge

```

---

## The Idea

Most GraphQL backends are just plumbing: take input, call an API, rename fields, and return. **The Bridge** turns that manual labor into a declarative graph of intent.

The engine resolves **backwards from demand**: when a GraphQL query requests `results[0].lat`, the engine traces the wire back to the `position.lat` of a specific API response. Only the data required to satisfy the query is ever fetched or executed.

### What it is (and isn't)

The Bridge is a **Smart Mapping Outgoing Proxy**, not a replacement for your application logic.

* **Use it to:** Morph external API shapes, enforce single exit points for security, and swap providers (e.g., SendGrid to Postmark) without changing app code.
* **Don't use it for:** Complex business logic or database transactions. Keep the "intelligence" in your Tools; keep the "connectivity" in your Bridge.

---

## The Language

### 1. Const Blocks (`const`)

Named JSON values reusable across tools and bridges. Avoids repetition for fallback payloads, defaults, and config fragments.

```hcl
const fallbackGeo = { "lat": 0, "lon": 0 }
const defaultCurrency = "EUR"
const maxRetries = 3
```

Access const values in bridges or tools via `with const as c`, then reference as `c.<name>.<path>`.

### 2. Extend Blocks (`extend`)

Defines the "Where" and the "How." Takes a function (or parent tool) and configures i, giving it a new namet.

```hcl
extend <source> as <name>
  [with context]                  # Injects GraphQL context (auth, secrets, etc.)
  [on error = <json_fallback>]    # Fallback value if tool fails
  [on error <- <source>]          # Pull fallback from context/tool
  
  <param> = <value>               # Constant/Default value
  <param> <- <source>             # Dynamic wire

```

When `<source>` is a function name (e.g. `httpCall`), a new tool is created.
When `<source>` is an existing tool name, the new tool inherits its configuration.

### 3. Bridge Blocks (`bridge`)

The resolver logic connecting GraphQL schema fields to your tools.

```hcl
bridge <Type.field>
  with <tool> [as <alias>]
  with input [as <i>]

  # Field Mapping
  <field> <- <source>               # Standard Pull (Lazy)
  <field> <-! <source>              # Forced Push (Eager/Side-effect)
  
  # Array Mapping
  <field>[] <- <source>[]
    .<sub_field> <- .<sub_src>      # Relative scoping

```

---

## Key Features

### Resiliency

Two layers of fault tolerance prevent a single API failure from crashing the response:

1. **Layer 1 — Tool `on error`**: Catches tool execution failures. Child tools inherit this via `extend`.
2. **Layer 2 — Wire `??` fallback**: Catches any failure in the resolution chain (missing data, network timeout) as a last resort.

```hcl
lat <- geo.lat ?? 0.0

```

### Forced Wires (`<-!`)

By default, the engine is **lazy**. Use `<-!` to force execution regardless of demand—perfect for side-effects like analytics, audit logging, or cache warming.

```hcl
bridge Mutation.updateUser
  with audit.logger as log

  # 'log' runs even if the client doesn't query the 'status' field
  status <-! log|i.changeData 

```

### The Pipe Operator (`|`)

Chains data through tools right-to-left: `dest <- tool | source`.

```hcl
# i.rawData -> normalize -> transform -> result
result <- transform|normalize|i.rawData 
```

Full example with a tool with 2 input parameters.

```hcl
extend currencyConverter as convert
  currency = EUR   # default currency

bridge Query.price
  with convert as c
  with input as i

c.currency <- i.currency   # overrides the default per request

# Safe to use repeatedly
itemPrice <- c|i.itemPrice
totalPrice <- c|i.totalPrice
```

---

## Syntax Reference

| Operator | Type | Behavior | Notes |
| --- | --- | --- | --- |
| **`=`** | **Constant** | Sets a static value. | |
| **`<-`** | **Wire** | Pulls data from a source at runtime. | |
| **`<-!`** | **Force** | Eagerly schedules a tool (for side-effects). | |
| **`\|`** | **Pipe** | Chains data through tools right-to-left. | |
| **`??`** | **Fallback** | Wire-level default if the resolution chain fails. | |
| **`on error`** | **Tool Fallback** | Returns a default if the tool's `fn(input)` throws. | |
| **`extend`** | **Tool Definition** | Configures a function or extends a parent tool. | |
| **`const`** | **Named Value** | Declares reusable JSON constants. | |
| **`[] <- []`** | **Map** | Iterates over arrays to create nested wire contexts. | |

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

The Bridge ships with built-in tools under the `std` namespace, always available by default. The `httpCall` tool lives at the root level for use in `extend` blocks.

| Namespace | Tool | Input | Output | Description |
| --- | --- | --- | --- | --- |
| *(root)* | `httpCall` | `{ baseUrl, method?, path?, headers?, ...fields }` | JSON response | REST API caller. GET fields → query params; POST/PUT/PATCH/DELETE → JSON body. |
| `std` | `upperCase` | `{ in: string }` | `string` | Converts `in` to UPPER CASE. |
| `std` | `lowerCase` | `{ in: string }` | `string` | Converts `in` to lower case. |
| `std` | `findObject` | `{ in: any[], ...criteria }` | `object \| undefined` | Finds the first object in `in` where all criteria match. |
| `std` | `pickFirst` | `{ in: any[], strict?: bool }` | `any` | Returns the first array element. With `strict = true`, throws if the array is empty or has more than one item. |
| `std` | `toArray` | `{ in: any }` | `any[]` | Wraps a single value in an array. Returns as-is if already an array. |

### Using Built-in Tools

**No `extend` block needed** for pipe-like tools — reference them with the `std.` prefix in the `with` header:

```hcl
bridge Query.format
  with std.upperCase as up
  with std.lowerCase as lo
  with input as i

upper <- up|i.text
lower <- lo|i.text
```

Use an `extend` block when you need to configure defaults:

```hcl
extend std.pickFirst as pf
  strict = true

bridge Query.onlyResult
  with pf
  with someApi as api
  with input as i

value <- pf|api.items
```

### Adding Custom Tools

The `std` namespace is always included automatically. Just add your own tools — no need to spread `builtinTools`:

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

---

## Why The Bridge?

* **No Resolver Sprawl:** Stop writing identical `fetch` and `map` logic.
* **Provider Agnostic:** Swap implementations (e.g., SendGrid vs Postmark) at the request level.
* **Edge-Ready:** Small footprint; works in Node, Bun, and Cloudflare Workers.
