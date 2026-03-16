import { regressionTest } from "./utils/regression.ts";
import { tools } from "./utils/bridge-tools.ts";
import { bridge } from "@stackables/bridge";

// ═══════════════════════════════════════════════════════════════════════════
// Chained providers
//
// Tests that output from one tool flows correctly as input to the next.
// Uses test.multitool (echo) to verify wire routing across a 3-tool chain:
//   input → gc → cx → ti → output
// ═══════════════════════════════════════════════════════════════════════════

regressionTest("alias keyword", {
  bridge: bridge`
    version 1.5

    bridge Array.is_wire {
      with context as c

      o.arrayWithFallback <- c.missingArray[] as i {
        .value <- i.value || "Fallback 1"
      } || c.realArray[] as i {
        .value <- i.value || "Fallback 2"
      } catch "No arrays"

    }

  `,
  disable: true,
  tools: tools,
  scenarios: {
    "Array.is_wire": {
      "falsy gate with 2 arrays": {
        context: {
          missingArray: undefined,
          realArray: [{ value: "Real value" }, { value: undefined }],
        },
        input: {},
        assertData: {
          arrayWithFallback: [{ value: "Real value" }, { value: "Fallback" }],
        },
        assertTraces: 0,
      },
    },
  },
});
