# Bridge Load Test

Compares three server implementations against a shared dependency emulator
using [k6](https://k6.io). Each service has its own Docker image.

## Services

| Service              | What it runs                                  | Port |
| -------------------- | --------------------------------------------- | ---- |
| `dependency`         | nginx serving static JSON fixtures            | 8080 |
| `bridge-standalone`  | Node.js (`executeBridge`)                     | 3000 |
| `bridge-graphql`     | Node.js (`bridgeTransform` + yoga)            | 3000 |
| `handcoded`          | Node.js (plain `fetch` + manual map)          | 3000 |

## Scenarios

| Scenario  | Description                                        |
| --------- | -------------------------------------------------- |
| `simple`  | Fetch one object, map 7 fields                     |
| `array`   | Fetch 100-item list, map 4 fields per item         |
| `complex` | 3 parallel fetches + array mapping + field merging |

## Quick start

```bash
cd loadtest

# Build & run the full sequential benchmark (~7 min)
docker compose up -d --build
docker compose run --rm k6
node scripts/report.mjs --out report.md
docker compose down

# Or use the npm scripts:
npm run up && npm test && npm run report && npm run down

# Quick smoke test (parallel, ~15s)
PROFILE=quick docker compose run --rm k6
```

## Directory layout

```
loadtest/
├── docker-compose.yml         orchestration
├── package.json               convenience npm scripts
│
├── dependency/                nginx static JSON server
│   ├── Dockerfile
│   ├── nginx.conf
│   └── data/                  pre-generated JSON fixtures
│
├── bridge-standalone/         Node.js executeBridge server
│   ├── Dockerfile
│   ├── bridge-standalone.ts
│   ├── endpoints.bridge
│   ├── package.json
│   └── tsconfig.json
│
├── bridge-graphql/            Node.js graphql-yoga + bridgeTransform
│   ├── Dockerfile
│   ├── bridge-graphql.ts
│   ├── endpoints.bridge
│   ├── schema.graphql
│   ├── package.json
│   └── tsconfig.json
│
├── handcoded/                 Node.js hand-coded baseline
│   ├── Dockerfile
│   ├── handcoded.ts
│   └── tsconfig.json
│
├── k6/
│   └── test.js                k6 load test script
│
├── scripts/
│   ├── generate-data.mjs      regenerate JSON fixtures
│   └── report.mjs             parse k6 output → comparison table
│
└── results/                   k6 output (gitignored)
```

## Regenerating test data

```bash
node scripts/generate-data.mjs
```

This writes JSON files into `dependency/data/`. The checked-in files are ready
to use — regenerate only if you want to change the fixture shape.
