import { regressionTest } from "../utils/regression.ts";
import { tools } from "../utils/bridge-tools.ts";
import { bridge } from "@stackables/bridge";

// ═══════════════════════════════════════════════════════════════════════════
// Overdefined tool-input race condition regression test
//
// When two wires target the same tool-input path (overdefinition), the engine
// must try them in cost order and short-circuit on the first non-nullish value.
//
// BUG: callTool (and evaluatePipeExpression / executeDefine) fired ALL input
// wires in parallel via `Promise.all`.  When `weather.lat <- i.latitude` and
// `weather.lat <- geo.lat` both existed, the geo tool was triggered even when
// `i.latitude` was provided — and `geo.q <- i.city || panic "need city"`
// panicked because city was not in the input.
//
// Two failing inputs:
//   1. { latitude: 47.37, longitude: 8.55 }  — coords provided, geo panics
//   2. { city: "Zurich" }                     — no coords, geo should fire
// ═══════════════════════════════════════════════════════════════════════════

regressionTest("overdefined tool-input: panic race condition", {
  bridge: bridge`
    version 1.5

    const coords = {
      "lat": 47,
      "lon": 8
    }

    bridge CoordOverdef.lookup {
      with test.multitool as geo
      with test.multitool as weather
      with const
      with input as i
      with output as o

      # geo requires city — panics when absent
      geo.q <- i.city || panic "city is required for geocoding"
      # Feed const coords so multitool echoes them back as geo.lat / geo.lon
      geo.lat <- const.coords.lat
      geo.lon <- const.coords.lon

      # Overdefined: direct input (cost 0) beats geo tool ref (cost 2)
      weather.lat <- i.latitude
      weather.lat <- geo.lat

      weather.lon <- i.longitude
      weather.lon <- geo.lon

      o.lat <- weather.lat
      o.lon <- weather.lon
    }
  `,
  tools: tools,
  scenarios: {
    "CoordOverdef.lookup": {
      "direct coords provided — geo must not fire (would panic)": {
        input: { latitude: 10, longitude: 20 },
        assertData: { lat: 10, lon: 20 },
        assertTraces: 1, // only weather tool called, geo skipped
      },
      "city provided — geo fires, coords come from geo result": {
        input: { city: "Zurich" },
        assertData: { lat: 47, lon: 8 },
        assertTraces: 2, // geo + weather
      },
      "both provided — direct coords win (cheaper), geo skipped": {
        input: { latitude: 1, longitude: 2, city: "Zurich" },
        assertData: { lat: 1, lon: 2 },
        assertTraces: 1, // only weather
      },
      "neither coords nor city — panic fires": {
        input: {},
        assertError: /city is required for geocoding/,
        assertTraces: 0,
        assertGraphql: () => {},
      },
    },
  },
});
