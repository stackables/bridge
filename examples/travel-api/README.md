# Travel API Example

A unified train-search gateway that routes to **Deutsche Bahn** (DB) or **Swiss Federal Railways** (SBB) based on a request header — demonstrating two key Bridge features:

1. **Nested array-in-array mapping** — `journeys[]` containing `legs[]`, each with explicit field remapping  
2. **Dynamic routing** — an `x-provider` header hot-swaps between two completely independent `.bridge` slices at request time

## Architecture

```
┌──────────────────────────────────────┐
│          GraphQL Gateway             │
│  TravelSearch.graphql (shared)       │
│                                      │
│  ┌──────────┐     ┌───────────┐      │
│  │ db.bridge│ ←── │x-provider │ ──→  │ sbb.bridge │
│  │ (DB API) │     │  header   │      │ (SBB API)  │
│  └──────────┘     └───────────┘      └────────────┘
└──────────────────────────────────────┘
```

Both bridge files map different REST APIs onto the **same** GraphQL schema, so consumers get a unified interface regardless of provider.

## What it shows

| Concept | Where |
|---|---|
| Nested `[] as` blocks (array-in-array) | `db.bridge`, `sbb.bridge` — `journeys[] as j { .legs <- j.legs[] as l { … } }` |
| `||` null-fallback inside element wires | `.id <- j.refreshToken \|\| "db-unknown"` |
| `on error` resilience | Both tools define `on error = { … }` so an API failure returns an empty list |
| Dynamic routing with `InstructionSource` | `server.ts` — `bridgeTransform(schema, (ctx) => …)` |
| Header-based slice selection | `x-provider: db` (default) or `x-provider: sbb` |

## Run

```bash
npx tsx server.ts
```

Then query with curl:

```bash
# Deutsche Bahn (default)
curl -X POST http://localhost:4000/graphql \
  -H "content-type: application/json" \
  -d '{"query": "{ searchTrains(from: \"8011160\", to: \"8000261\") { provider legs { trainName } } }"}'

# Swiss Federal Railways
curl -X POST http://localhost:4000/graphql \
  -H "content-type: application/json" \
  -H "x-provider: sbb" \
  -d '{"query": "{ searchTrains(from: \"Zürich\", to: \"Bern\") { provider legs { trainName } } }"}'
```

## Test

```bash
pnpm e2e
```


