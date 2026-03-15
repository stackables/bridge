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

    define reusable {
      with inout as i
      with output as o
      
      alias temp <- i.value || "Default" catch "Error"

      o.result <- temp
    }

    bridge Alias.syntax {
      with test.multitool as array
      with test.multitool as object
      with reusable as r
      with context
      with input as i
      with output as o

      # The usual complex reusable alias
      alias user_info <- object?.user.info || i.info catch "Unknown"

      # Alias can store the array mapping result
      alias raw_response <- array[] as i {

        alias in_loop <- i.name || "No name"

        .name <- in_loop
        .info <- user_info
      }

      # Alias can be used in alias
      alias safe_response <- raw_response catch []

      o.names <- safe_response
      o.info <- user_info

      # Alias used inside the define block
      r.value <- i.info
      o.reusable_result <- r.result
    }
  `,
  tools: tools,
  scenarios: {
    "Alias.syntax": {},
  },
});
