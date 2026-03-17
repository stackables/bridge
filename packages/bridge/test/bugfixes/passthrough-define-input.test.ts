import { regressionTest } from "../utils/regression.ts";
import { bridge } from "@stackables/bridge";

// ═══════════════════════════════════════════════════════════════════════════
// Passthrough bridge + define: lazy input resolution regression test
//
// The `bridge Query.X with defineName` syntax creates a passthrough bridge
// that delegates entirely to a define block.  The define's inputs are
// registered as lazy factories under an empty pathKey ("").
//
// BUG 1: resolveLazyInput parent-path lookup used `len >= 1`, so the loop
// never reached `len = 0` to find the lazy factory at key "" — meaning the
// define's inputs were never hydrated.
//
// BUG 2: `"".split(".")` returns `[""]` not `[]`, so `setPath(selfInput,
// [""], value)` set `selfInput[""] = value` instead of merging the define's
// resolved value into the root `selfInput` object.
//
// Result: passthrough bridges silently dropped all input fields — the define
// block received an empty object.
// ═══════════════════════════════════════════════════════════════════════════

regressionTest("passthrough bridge with define: lazy input resolution", {
  disable: ["compiled"],
  bridge: bridge`
    version 1.5

    define weatherLookup {
      with weatherApi as w
      with input as i
      with output as o

      w.lat <- i.latitude
      w.lon <- i.longitude

      o.temperature <- w.temp
      o.lat         <- i.latitude
      o.lon         <- i.longitude
    }

    # Passthrough: entire bridge forwards to the define
    bridge Query.weatherPassthrough with weatherLookup

    # Control: same define used with explicit wiring (always worked)
    bridge Query.weatherExplicit {
      with weatherLookup as wl
      with input as i
      with output as o

      wl.latitude  <- i.latitude
      wl.longitude <- i.longitude
      o <- wl
    }
  `,
  scenarios: {
    "Query.weatherPassthrough": {
      "passthrough forwards all input fields to define": {
        input: { latitude: 47.37, longitude: 8.55 },
        tools: {
          weatherApi: async (input: any) => ({
            temp: 18.5,
            lat: input.lat,
            lon: input.lon,
          }),
        },
        assertData: { temperature: 18.5, lat: 47.37, lon: 8.55 },
        assertTraces: 1,
      },
      "passthrough with nested input fields": {
        input: { latitude: -33.87, longitude: 151.21 },
        tools: {
          weatherApi: async (input: any) => ({
            temp: 25.0,
            lat: input.lat,
            lon: input.lon,
          }),
        },
        assertData: { temperature: 25.0, lat: -33.87, lon: 151.21 },
        assertTraces: 1,
      },
    },
    "Query.weatherExplicit": {
      "explicit wiring works (control case)": {
        input: { latitude: 47.37, longitude: 8.55 },
        tools: {
          weatherApi: async (input: any) => ({
            temp: 18.5,
            lat: input.lat,
            lon: input.lon,
          }),
        },
        assertData: { temperature: 18.5, lat: 47.37, lon: 8.55 },
        assertTraces: 1,
      },
    },
  },
});
