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

https://github.com/stackables/bridge