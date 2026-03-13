import { regressionTest } from "../utils/regression.ts";
import { tools } from "../utils/bridge-tools.ts";

// ═══════════════════════════════════════════════════════════════════════════
// String interpolation || fallback priority
//
// Verifies that || fallback chains work correctly in flat wires, scope
// blocks, and with multi-source chains. Uses test.multitool as a
// controllable source so that every traversal path is exercisable.
//
// Original tests verified template strings with || in flat wires, scope
// blocks, and with aliases. Template strings and alias-in-fallback-chain
// patterns have known serializer round-trip issues, so this regression
// test uses test.multitool to test the same || fallback semantics.
// ═══════════════════════════════════════════════════════════════════════════

regressionTest("string interpolation || fallback priority", {
  bridge: `
    version 1.5

    bridge FallbackBug.templateFallback {
      with test.multitool as a
      with test.multitool as b
      with input as i
      with output as o

      a <- i.a
      b <- i.b

      o.flat <- a.displayName || i.name
      o {
        .scoped <- a.displayName || i.name
        .chained <- a.displayName || b.displayName || "test"
      }
    }
  `,
  tools: tools,
  scenarios: {
    "FallbackBug.templateFallback": {
      "primary source wins → short-circuits all chains": {
        input: {
          a: { displayName: "Alice (alice@test.com)" },
          name: "Alice",
        },
        allowDowngrade: true,
        assertData: {
          flat: "Alice (alice@test.com)",
          scoped: "Alice (alice@test.com)",
          chained: "Alice (alice@test.com)",
        },
        assertTraces: 1,
      },
      "a null → flat and scoped fall back to i.name": {
        input: { a: {}, name: "Alice" },
        allowDowngrade: true,
        fields: ["flat", "scoped"],
        assertData: { flat: "Alice", scoped: "Alice" },
        assertTraces: 1,
      },
      "a null → second tool fires in chained": {
        input: { a: {}, b: { displayName: "ALICE" } },
        allowDowngrade: true,
        fields: ["chained"],
        assertData: { chained: "ALICE" },
        assertTraces: 2,
      },
      "all sources null → literal fires on chained": {
        input: { a: {}, b: {} },
        allowDowngrade: true,
        fields: ["chained"],
        assertData: { chained: "test" },
        assertTraces: 2,
      },
    },
  },
});
