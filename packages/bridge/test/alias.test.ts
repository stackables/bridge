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

    bridge Alias.syntax {
      with test.multitool as object
      with input as i
      with output as o

      # Simple alias with fallback and catch
      alias user_info <- object?.user.info || i.info catch "Unknown"

      o.info <- user_info
    }
  `,
  tools: tools,
  scenarios: {
    "Alias.syntax": {},
  },
});
