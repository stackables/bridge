# Apollo Federation Subgraph Example

Expose a bridge-engine schema as an [Apollo Federation](https://www.apollographql.com/docs/federation/) subgraph.

## Files

- `Geocode.graphql` — GraphQL schema (reused from yoga example)
- `hereapi.bridge` — provider definition + field wiring
- `server.ts` — wraps it as a federation subgraph

`bridgeTransform` returns a standard `GraphQLSchema` — works with any server. For federation, use `@apollo/subgraph` + `@apollo/server`.

## Install

```bash
pnpm add @apollo/server @apollo/subgraph graphql
```

## Run

```bash
HEREAPI_KEY=your-key npx tsx examples/apollo-federation/server.ts
```

The subgraph exposes its schema at `http://localhost:4001/` and can be composed into an Apollo gateway / router.
