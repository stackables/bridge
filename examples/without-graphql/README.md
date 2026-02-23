# Without GraphQL Example

Demonstrates running Bridge **without a GraphQL server** — no schema, no yoga, no HTTP layer.
The `executeBridge()` API lets you use Bridge's declarative data-wiring in CLI tools,
background jobs, scripts, or anywhere a full GraphQL stack would be overkill.

## What it shows

| Concern | How |
|---|---|
| **Object output** | `weather.bridge` — geocode + weather fields wired into a plain object |
| **Array output** | `sbb.bridge` — transport API connections mapped to an array with nested legs |
| **No server** | `executeBridge()` runs the bridge in-process; result is a plain JS value |
| **Generic CLI** | `cli.ts` works with any `.bridge` file — no code changes needed per-file |

## Run

```bash
# Weather: object output (2 HTTP calls, no auth)
node --import tsx/esm cli.ts weather.bridge '{"city":"Berlin"}'

# Swiss trains: array output with nested legs (no auth)
node --import tsx/esm cli.ts sbb.bridge '{"from":"Bern","to":"Zürich"}'

# Or via pnpm scripts
pnpm weather
pnpm sbb
```

## CLI usage

```
cli.ts <bridge-file> [input-json] [options]

Options:
  --operation <Type.field>   Which bridge to run (default: first bridge in file)
  --trace                    Print tool call timings after the result
  -h, --help                 Show help
```

### Examples

```bash
# Custom input
node --import tsx/esm cli.ts weather.bridge '{"city":"Tokyo"}'

# Select a specific bridge when a file defines more than one
node --import tsx/esm cli.ts multi.bridge '{}' --operation Query.myField

# Show tool traces
node --import tsx/esm cli.ts sbb.bridge '{"from":"Basel","to":"Luzern"}' --trace
```

The JSON result is written to **stdout**; progress and trace lines go to **stderr**,
so the output can be piped cleanly:

```bash
node --import tsx/esm cli.ts weather.bridge '{"city":"Paris"}' | jq .temperature
```

## Using `executeBridge()` directly

```ts
import { readFileSync } from "node:fs";
import { parseBridgeDiagnostics, executeBridge } from "@stackables/bridge";

const { instructions } = parseBridgeDiagnostics(
  readFileSync("weather.bridge", "utf8"),
);

const { data } = await executeBridge({
  instructions,
  operation: "Query.getWeather",
  input: { city: "Berlin" },
});

console.log(data);
// { city: 'Berlin', lat: '52.5...', lon: '13.3...', temperature: 8.2, unit: '°C', timezone: 'GMT' }
```

## E2E tests

```bash
pnpm e2e
```

Tests spawn the CLI as a subprocess and assert on its JSON stdout output.

## Bridge files

- `weather.bridge` — geocodes a city name (Nominatim) then fetches current temperature (Open-Meteo); no API keys required
- `sbb.bridge` — queries the Swiss public transport API for connections between two stations; returns an array with departure/arrival times and per-leg details; no API keys required
