# Composed Gateway Example

Demonstrates **gateway-level composability** — multiple schemas, multiple `.bridge` files, and hand-coded resolvers coexisting in a single GraphQL endpoint.

## What it shows

| Concern | How |
|---|---|
| **Two schemas** | `Weather.graphql` (reused from `weather-api`) + `Quotes.graphql` merged via `createSchema({ typeDefs: [...] })` |
| **Two bridge files** | `Weather.bridge` + `Quotes.bridge` concatenated into one instruction set — `bridgeTransform` matches by `type.field` |
| **Hand-coded resolver** | `Mutation.saveQuote` is plain TypeScript; Bridge skips fields with no matching instruction |
| **Single endpoint** | All three concerns are served as one unified GraphQL API at `http://localhost:4000/graphql` |

## Run

```bash
pnpm install
pnpm start
```

## Queries

```graphql
# Weather (bridge-powered)
{ getWeatherByName(cityName: "Paris") { city currentTemp timezone } }

# Quote (bridge-powered)
{ randomQuote { text author } }

# Save quote (hand-coded)
mutation { saveQuote(text: "Hello", author: "World") { id savedAt } }

# Cross-domain in one request
{
  getWeatherByCoordinates(lat: "48.86", lon: "2.35") { currentTemp }
  randomQuote { text author }
}
```

## E2E tests

```bash
pnpm e2e
```

## Key insight

`bridgeTransform` only intercepts root fields that have a matching `bridge` instruction. Everything else passes through to the original resolver. This means you can:

1. Merge any number of schemas
2. Concatenate instructions from any number of `.bridge` files
3. Define hand-coded resolvers for fields that need imperative logic
4. Apply `bridgeTransform` once — it's additive, not destructive
