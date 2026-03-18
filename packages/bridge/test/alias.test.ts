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
      with output as o
      with context as c
      with test.multitool as echo

      echo.items <- c.items

      o.arrayWithFallback <- echo.items[] as i {
        .value <- i.value || "Fallback 1"
      } || c.realArray[] as i {
        .value <- i.value || "Fallback 2"
      } catch []

    }

  `,
  disable: ["compiled"],
  tools: tools,
  scenarios: {
    "Array.is_wire": {
      "primary tool array present — uses first mapping": {
        context: {
          items: [{ value: "A" }, { value: undefined }],
          realArray: [{ value: "should not appear" }],
        },
        input: {},
        assertData: {
          arrayWithFallback: [{ value: "A" }, { value: "Fallback 1" }],
        },
        assertTraces: 1,
      },
      "primary tool returns null — falls through to second array": {
        context: {
          items: undefined,
          realArray: [{ value: "Real value" }, { value: undefined }],
        },
        input: {},
        assertData: {
          arrayWithFallback: [{ value: "Real value" }, { value: "Fallback 2" }],
        },
        assertTraces: 1,
      },
      "primary is empty array — stays empty (truthy)": {
        context: {
          items: [],
          realArray: [{ value: "B" }],
        },
        input: {},
        assertData: {
          arrayWithFallback: [],
        },
        assertTraces: 1,
      },
      "both null — result is null": {
        context: {
          items: undefined,
          realArray: undefined,
        },
        input: {},
        assertData: {
          arrayWithFallback: null,
        },
        assertTraces: 1,
      },
      "tool errors — catch fires": {
        context: {
          items: "will cause _error",
          realArray: undefined,
        },
        tools: {
          "test.multitool": (() => {
            const fn = () => {
              throw new Error("forced");
            };
            fn.bridge = { sync: true };
            return fn;
          })(),
        },
        input: {},
        assertData: {
          arrayWithFallback: [],
        },
        assertTraces: 1,
      },
    },
  },
});
