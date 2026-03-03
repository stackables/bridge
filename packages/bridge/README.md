[![github](https://img.shields.io/badge/github-stackables/bridge-blue?logo=github)](https://github.com/stackables/bridge)

# The Bridge

**Declarative dataflow for GraphQL.**
Wire data between APIs, tools, and fields using `.bridge` files—no resolvers, no codegen, no plumbing.

```bash
npm install @stackables/bridge
```

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

```bridge
version 1.5

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

## Linting

The package ships a `bridge-lint` CLI to validate `.bridge` files from the terminal or CI.

```bash
# Lint a single file
npx bridge-lint path/to/logic.bridge

# Lint multiple files / globs
npx bridge-lint src/**/*.bridge

# Output diagnostics as JSON (for tooling / CI integration)
npx bridge-lint --json src/**/*.bridge
```

Exit code is `1` when any errors are present, `0` when everything is clean.

---

## Packages

`@stackables/bridge` is the all-in-one — it re-exports everything so you can get started fast. But you don't always need the full stack. If you're optimizing for bundle size (say, deploying to Cloudflare Workers), pick only the packages you need:

| Package                                                                                    | Role                     | When to reach for it                                                        |
| ------------------------------------------------------------------------------------------ | ------------------------ | --------------------------------------------------------------------------- |
| [`@stackables/bridge-core`](https://www.npmjs.com/package/@stackables/bridge-core)         | **The Engine**           | Edge workers, serverless — run pre-compiled instructions without the parser |
| [`@stackables/bridge-parser`](https://www.npmjs.com/package/@stackables/bridge-parser)     | **The Parser**           | Parse `.bridge` files into a BridgeDocument (AST)                           |
| [`@stackables/bridge-compiler`](https://www.npmjs.com/package/@stackables/bridge-compiler) | **The Compiler**         | Compile BridgeDocument into optimized JavaScript                            |
| [`@stackables/bridge-graphql`](https://www.npmjs.com/package/@stackables/bridge-graphql)   | **The Adapter**          | Wire bridge instructions into an Apollo or Yoga GraphQL schema              |
| [`@stackables/bridge-stdlib`](https://www.npmjs.com/package/@stackables/bridge-stdlib)     | **The Standard Library** | Customize or extend httpCall, string/array tools, audit, assert             |
| [`@stackables/bridge-types`](https://www.npmjs.com/package/@stackables/bridge-types)       | **Shared Types**         | Writing a custom tool library or framework integration                      |

See the [Package Selection guide](https://bridge.sdk42.com/advanced/packages/) for common deployment patterns (JIT vs AOT).

**VS Code extension:** search for [**"The Bridge Language"**](https://marketplace.visualstudio.com/items?itemName=stackables.bridge-syntax-highlight) in the Extensions panel for syntax highlighting, diagnostics, and hover.
