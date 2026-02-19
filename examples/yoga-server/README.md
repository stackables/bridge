# Yoga Server Example

Standard GraphQL server using [graphql-yoga](https://the-guild.dev/graphql/yoga-server) with bridge-engine.

## Files

- `Geocode.graphql` — GraphQL schema
- `hereapi.bridge` — provider definition + field wiring
- `server.ts` — spins up the server from the two files

Context (API keys, auth tokens) is passed via GraphQL context — the standard pattern.

## Run

```bash
HEREAPI_KEY=your-key npx tsx examples/yoga-server/server.ts
```

Then:

```bash
curl http://localhost:4000/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query": "{ geocode(search: \"Berlin\", limit: 5) { search results { name lat lon } } }"}'
```
