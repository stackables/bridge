/**
 * Wires — How data flows through a Bridge program
 *
 * Everything in Bridge is a wire. This file shows every wire variant
 * in one bridge block so you can see how they work together.
 */

import { regressionTest } from "../utils/regression.ts";
import { tools } from "../utils/bridge-tools.ts";
import { bridge } from "@stackables/bridge";

regressionTest("wires", {
  bridge: bridge`
    version 1.5

    # ── const blocks live outside bridges and hold static JSON ──
    const defaults = { "currency": "EUR", "locale": "de-CH" }

    bridge Wires.showcase {
      with test.multitool as api
      with test.multitool as second
      with input as i
      with context as ctx
      with const as c
      with output as o

      # ── pull wire (<-): read a value from a source ──────────────
      # from input — flat and nested paths, including deep access
      o.name    <- i.name
      o.city    <- i.address.city
      o.zip     <- i.address.postal.zip

      # from context — server-side values the caller can't control
      o.region  <- ctx.region

      # from a const block — accessed via c.<constName>.<field>
      o.currency <- c.defaults.currency

      # ── constant wire (=): literal value ─────────────────────────
      o.greeting = "hello"
      o.limit    = 100
      o.enabled  = true

      # ── wiring into tool inputs ─────────────────────────────────
      # root wire: pass entire object as the tool's input
      api <- i.request

      # field wires: set individual tool input fields
      api.token <- ctx.apiKey

      # ── pull from tool output ───────────────────────────────────
      # ?. = safe access — if the tool errors, yield null instead of failing
      # (strict access without ?. propagates errors — see throw-and-panic)
      o.itemCount <- api?.count

      # ── chaining: one tool's output feeds the next ──────────────
      second.value <- api?.processed
      o.chained    <- second?.value
    }

    # ── passthrough wire: return entire object as root output ─────
    bridge Wires.passthrough {
      with test.multitool as api
      with input as i
      with output as o

      api <- i.request
      o <- api?.user
    }
  `,
  tools,
  scenarios: {
    "Wires.showcase": {
      "all wire types producing output together": {
        input: {
          name: "Alice",
          address: { city: "Zürich", postal: { zip: "8001" } },
          request: { count: 42, processed: "step-1" },
        },
        context: { region: "eu", apiKey: "sk-1" },
        assertData: {
          name: "Alice",
          city: "Zürich",
          zip: "8001",
          region: "eu",
          currency: "EUR",
          greeting: "hello",
          limit: 100,
          enabled: true,
          itemCount: 42,
          chained: "step-1",
        },
        assertTraces: 2,
      },
    },
    "Wires.passthrough": {
      "passthrough returns entire nested object as root": {
        input: { request: { user: { id: 1, name: "Alice", role: "admin" } } },
        assertData: { id: 1, name: "Alice", role: "admin" },
        assertTraces: 1,
      },
    },
  },
});
