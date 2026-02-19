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

### 2. Tool Blocks (`tool`)

Defines the "Where" and the "How."

```hcl
tool <name> [extends <parent>] [<toolFunction>]
  [with context]                  # Injects GraphQL context (auth, secrets, etc.)
  [on error = <json_fallback>]    # Fallback value if tool fails
  [on error <- <source>]          # Pull fallback from context/tool
  
  <param> = <value>               # Constant/Default value
  <param> <- <source>             # Dynamic wire

```

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

1. **Layer 1 — Tool `on error`**: Catches tool execution failures. Child tools inherit this via `extends`.
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
tool convert currencyConverter
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

The Bridge ships with a set of built-in tools available by default. When no `tools` option is provided, `builtinTools` is used automatically.

| Tool | Input | Output | Description |
| --- | --- | --- | --- |
| `httpCall` | `{ baseUrl, method?, path?, headers?, ...fields }` | JSON response | REST API caller. GET fields → query params; POST/PUT/PATCH/DELETE → JSON body. |
| `upperCase` | `{ in: string }` | `string` | Converts `in` to UPPER CASE. |
| `lowerCase` | `{ in: string }` | `string` | Converts `in` to lower case. |
| `findObject` | `{ in: any[], ...criteria }` | `object \| undefined` | Finds the first object in `in` where all criteria match. |
| `pickFirst` | `{ in: any[], strict?: bool }` | `any` | Returns the first array element. With `strict = true`, throws if the array is empty or has more than one item. |
| `toArray` | `{ in: any }` | `any[]` | Wraps a single value in an array. Returns as-is if already an array. |

### Using Built-in Tools

**No `tool` block needed** for pipe-like tools — reference them directly in the `with` header:

```hcl
bridge Query.format
  with upperCase as up
  with lowerCase as lo
  with input as i

upper <- up|i.text
lower <- lo|i.text
```

Use a `tool` block only when you need to configure defaults:

```hcl
tool pf pickFirst
  strict = true

bridge Query.onlyResult
  with pf
  with someApi as api
  with input as i

value <- pf|api.items
```

### Overriding Tools

If you provide a `tools` object it **replaces** the defaults entirely. To keep the built-ins alongside your own tools, spread `builtinTools`:

```typescript
import { bridgeTransform, builtinTools } from "@stackables/bridge";

const schema = bridgeTransform(createSchema({ typeDefs }), instructions, {
  tools: {
    ...builtinTools,
    myCustomTool: (input) => ({ result: input.value * 2 }),
  },
});
```

If you only need your own tools and none of the built-ins:

```typescript
const schema = bridgeTransform(createSchema({ typeDefs }), instructions, {
  tools: {
    myOnlyTool: async (input) => fetchFromMyApi(input),
  },
});
```

---

## Why The Bridge?

* **No Resolver Sprawl:** Stop writing identical `fetch` and `map` logic.
* **Provider Agnostic:** Swap implementations (e.g., SendGrid vs Postmark) at the request level.
* **Edge-Ready:** Small footprint; works in Node, Bun, and Cloudflare Workers.
