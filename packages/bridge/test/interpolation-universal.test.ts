import { regressionTest } from "./utils/regression.ts";
import { tools } from "./utils/bridge-tools.ts";

// ═══════════════════════════════════════════════════════════════════════════
// Universal interpolation — templates combined with other operators
//
// Tests || fallback and ternary operator behavior. Uses test.multitool
// for controllable sources. Template strings in || / ternary positions
// have known serializer round-trip issues, so we test the fallback/ternary
// semantics directly with input and tool values.
//
// String interpolation itself is covered in string-interpolation.test.ts.
// ═══════════════════════════════════════════════════════════════════════════

regressionTest("universal interpolation: fallback", {
  bridge: `
    version 1.5

    bridge Interp.fallback {
      with test.multitool as src
      with input as i
      with output as o

      src <- i.src
      o.displayName <- i.email || src.fallbackDisplay
      o.label <- i.nickname || src.fallbackLabel
    }

    bridge Interp.arrayFallback {
      with input as i
      with output as o

      o <- i.items[] as item {
        .label <- item.customLabel || item.defaultLabel
      }
    }
  `,
  tools: tools,
  scenarios: {
    "Interp.fallback": {
      "primary truthy → fallback skipped": {
        input: {
          email: "alice@test.com",
          nickname: "Ally",
          src: { fallbackDisplay: "unused", fallbackLabel: "unused" },
        },
        allowDowngrade: true,
        assertData: { displayName: "alice@test.com", label: "Ally" },
        assertTraces: 0,
      },
      "primary null → fallback fires": {
        input: {
          email: null,
          nickname: null,
          src: {
            fallbackDisplay: "Jane Doe (jane@test.com)",
            fallbackLabel: "Jane Doe",
          },
        },
        allowDowngrade: true,
        assertData: {
          displayName: "Jane Doe (jane@test.com)",
          label: "Jane Doe",
        },
        assertTraces: 1,
      },
    },
    "Interp.arrayFallback": {
      "|| fallback inside array mapping": {
        input: {
          items: [
            { id: "1", name: "Widget", customLabel: null, defaultLabel: "Widget (#1)" },
            { id: "2", name: "Gadget", customLabel: "Custom", defaultLabel: "Gadget (#2)" },
          ],
        },
        assertData: [{ label: "Widget (#1)" }, { label: "Custom" }],
        assertTraces: 0,
      },
      "empty array": {
        input: { items: [] },
        assertData: [],
        assertTraces: 0,
      },
    },
  },
});

regressionTest("universal interpolation: ternary", {
  bridge: `
    version 1.5

    bridge Interp.ternary {
      with input as i
      with output as o

      o.greeting <- i.isVip ? i.vipGreeting : i.normalGreeting
    }
  `,
  scenarios: {
    "Interp.ternary": {
      "ternary then-branch fires when truthy": {
        input: {
          isVip: true,
          vipGreeting: "Welcome VIP Alice!",
          normalGreeting: "Hello Alice",
        },
        assertData: { greeting: "Welcome VIP Alice!" },
        assertTraces: 0,
      },
      "ternary else-branch fires when falsy": {
        input: {
          isVip: false,
          vipGreeting: "Welcome VIP Bob!",
          normalGreeting: "Hello Bob",
        },
        assertData: { greeting: "Hello Bob" },
        assertTraces: 0,
      },
    },
  },
});
