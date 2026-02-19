# The Bridge

**Declarative dataflow for GraphQL.**
Wire data between APIs, tools, and fields using `.bridge` files—no resolvers, no codegen, no plumbing.

```
npm install @stackables/bridge
```

---

## The Idea

Most GraphQL backends are just plumbing: take input, call an API, rename fields, call another API with the result, and return. **The Bridge** turns that manual labor into a declarative graph of intent.

The engine resolves **backwards from demand**: when a GraphQL query requests `results[0].lat`, the engine traces the wire back to the `position.lat` of a specific API response. Only the data required to satisfy the query is ever fetched or executed.

---

## The Language

The Bridge uses a simple, three-keyword syntax designed for both humans and LLMs.

### 1. Tool Blocks (`tool`)

A **Tool** is a reusable definition of an external service or a local function. It handles the "Where" and the "How."

```hcl
# Base configuration
tool hereapi httpCall
  with config
  baseUrl = "https://geocode.search.hereapi.com/v1"
  headers.apiKey <- config.hereapi.apiKey

# Inheritance: Child overrides or adds to parent
tool hereapi.geocode extends hereapi
  method = GET
  path = /geocode

```

- **`extends`**: Builds a specialized tool from a base (inherits wires, auth, and deps).
- **`with config`**: Injects deployment-level secrets or environment variables.
- **`with <tool> as <handle>`**: Declares a dependency on another tool (e.g., for OAuth tokens).

### 2. Bridge Blocks (`bridge`)

A **Bridge** is the resolver logic. It connects a GraphQL schema field to your tools.

```hcl
bridge Query.geocode
  with hereapi.geocode as gc
  with input as i

# Direct wiring
gc.q <- i.search

# Array mapping (the shadow tree)
results[] <- gc.items[]
  .name <- .title
  .lat  <- .position.lat
  .lon  <- .position.lng

```

### 3. Pipe Operator (`|`)

The pipe operator is shorthand for routing data through a tool inline. Instead of explicitly wiring a tool's input and output fields, you write:

```hcl
# Without pipe (explicit wiring)
with pluckText as pt
pt.in <- rv.comments
result <- pt

# With pipe — same thing, one line
with pluckText as pt
result <- pt|rv.comments
```

Chains execute right-to-left — `source → h2 → h1 → dest`:

```hcl
with normalize as n
with pluckText as pt
result <- pt|n|rv.comments   # rv.comments → n → pt → result
```

**Each pipe use is an independent call.** Two lines using the same handle produce two separate tool invocations:

```hcl
with double as d
doubled.a <- d|i.a   # independent call, input = i.a
doubled.b <- d|i.b   # independent call, input = i.b
```

**Named input field** — if the tool's primary input isn't called `in`, specify it with a dot:

```hcl
with divide as dv
result <- dv.dividend|i.amount   # wires i.amount → dv.dividend
dv.divisor <- i.rate             # extra param wired normally
```

**Extra params** — any non-pipe wires on the handle are applied to every call of that handle:

```hcl
tool convertToEur currencyConverter
  currency = EUR   # default baked into the tool

bridge Query.price
  with convertToEur
  with input as i

convertToEur.currency <- i.currency   # overrides the default per request
price <- convertToEur|i.amount
```

Tool functions used in pipes receive all their inputs as a flat object and return their result directly — no wrapper needed:

```typescript
tools: {
  pluckText:         ({ in: items })           => items.map(i => i.text),
  currencyConverter: ({ in: amount, currency }) => amount / rates[currency],
}
```

### 4. Syntax Reference

| Operator            | Type         | Behavior                                                            |
| ------------------- | ------------ | ------------------------------------------------------------------- |
| **`=`**             | **Constant** | Sets a static value (e.g., `method = GET`).                         |
| **`<-`**            | **Wire**     | Pulls data from a source at runtime.                                |
| **`[] <- []`**      | **Map**      | Iterates over an array, creating a shadow context for nested wires. |
| **`<- handle\|…`** | **Pipe**     | Routes data through a tool inline. Each use is an independent call. |

---

## Usage

The Bridge is designed to be unopinionated. It wraps your existing GraphQL schema, acting as the logic layer that handles the `resolve` function for any field it's wired to.

### 1. Basic Setup (with GraphQL Yoga)

```typescript
import { createSchema, createYoga } from "graphql-yoga";
import { createServer } from "node:http";
import { bridgeTransform, parseBridge } from "@stackables/bridge";

const typeDefs = /* your .graphql string */;
const instructions = parseBridge(/* your .bridge string */);

// Transform the schema: Bridge now handles the resolvers
const schema = bridgeTransform(createSchema({ typeDefs }), instructions);

const yoga = createYoga({
  schema,
  context: () => ({
    // Config is injected into 'with config' blocks
    config: { hereapi: { apiKey: process.env.HEREAPI_KEY } },
  }),
});

createServer(yoga).listen(4000);

```

### 2. Custom Tools (Data Transformation)

For logic beyond HTTP calls, register custom tool functions.

```typescript
const schema = bridgeTransform(createSchema({ typeDefs }), instructions, {
  tools: {
    centsToUsd: (input: { cents: number }) => ({ dollars: input.cents / 100 }),
  },
});
```

---

## Advanced: Multi-Provider Routing

The Bridge excels at "Provider Agnostic" APIs. You can have multiple `.bridge` files implementing the same GraphQL field (e.g., `sendgrid.bridge` and `mailjet.bridge`). Pass a function instead of a static array to select the implementation per-request:

```typescript
import { bridgeTransform, parseBridge } from "@stackables/bridge";

const bridges = {
  sendgrid: parseBridge(sendgridText),
  mailjet: parseBridge(mailjetText),
};

const schema = bridgeTransform(
  createSchema({ typeDefs }),
  (ctx) => bridges[ctx.provider] ?? bridges.sendgrid,
);

const yoga = createYoga({
  schema,
  context: (req) => ({
    provider: req.headers.get("x-provider"),
    config: { /* ... */ },
  }),
});
```

The routing logic is entirely yours — header-based, tenant-based, cookie-based, whatever you need. The engine just calls the function with the full GraphQL context.

---

## Why The Bridge?

- **No Resolver Sprawl:** Stop writing identical `fetch` and `map` logic 50 times in TypeScript.
- **LLM-Friendly:** The `tool` and `bridge` metaphors are natively understood by modern AI models for integration generation.
- **Lazy by Design:** If a client doesn't ask for a field, the engine doesn't fetch the data. No "over-fetching" by default.
- **Edge-Ready:** Small footprint, no heavy dependencies, works in Node, Bun, and Cloudflare Workers.

---

## API Reference

### `parseBridge(text: string): Instruction[]`

Parses Bridge-lang text into a serializable instruction set.

### `bridgeTransform(schema, instructions, options?)`

Wraps a `GraphQLSchema`. `instructions` can be an `Instruction[]` or a `(context) => Instruction[]` function for per-request routing. Options:

- `tools` — custom tool functions
- `configKey` — context key to read config from (default: `"config"`)

Config is read from `context.config` (or `context[configKey]`) at request time.

### `createHttpCall(fetchFn?)`

The default `httpCall` implementation. Supports all standard HTTP methods. Automatically maps parameters to query strings (GET) or JSON bodies (POST/PUT).
