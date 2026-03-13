import { regressionTest } from "./utils/regression.ts";
import { tools } from "./utils/bridge-tools.ts";

// ═══════════════════════════════════════════════════════════════════════════
// Chained providers
//
// Tests that output from one tool flows correctly as input to the next.
// Uses test.multitool (echo) to verify wire routing across a 3-tool chain:
//   input → gc → cx → ti → output
// ═══════════════════════════════════════════════════════════════════════════

regressionTest("chained providers", {
  bridge: `
    version 1.5

    bridge Chained.livingStandard {
      with test.multitool as gc
      with test.multitool as cx
      with test.multitool as ti
      with input as i
      with output as out

      gc <- i.gc
      cx.x <- gc.lat
      cx.y <- gc.lon
      cx.lifeExpectancy <- gc.lifeExpectancy
      ti.value <- cx.lifeExpectancy
      out.lifeExpectancy <- ti.value
      out.geoLat <- cx.x
      out.geoLon <- cx.y
    }
  `,
  tools: tools,
  scenarios: {
    "Chained.livingStandard": {
      "input → gc → cx → ti → output": {
        input: { gc: { lat: 52.53, lon: 13.38, lifeExpectancy: "81.5" } },
        assertData: {
          lifeExpectancy: "81.5",
          geoLat: 52.53,
          geoLon: 13.38,
        },
        assertTraces: 3,
      },
      "gc error → chain fails": {
        input: { gc: { _error: "geocode failed" } },
        assertError: /geocode failed/,
        assertTraces: 1,
      },
    },
  },
});
