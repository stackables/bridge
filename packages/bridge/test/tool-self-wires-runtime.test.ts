/**
 * Runtime execution tests for tool self-wires.
 *
 * These verify that tool self-wires with expressions, string interpolation,
 * ternary, coalesce, catch, and not prefix actually EXECUTE correctly
 * at runtime — not just parse correctly.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { forEachEngine } from "./utils/dual-run.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** A simple echo tool that returns its entire input. */
async function echo(input: Record<string, any>) {
  return input;
}

// ══════════════════════════════════════════════════════════════════════════════
// Tool self-wire runtime execution tests
// ══════════════════════════════════════════════════════════════════════════════

forEachEngine("tool self-wire runtime", (run) => {
  // ── Constants ─────────────────────────────────────────────────────────────

  test("constant self-wires pass values to tool", async () => {
    const { data } = await run(
      `version 1.5
tool myApi from echo {
  .greeting = "hello"
  .count = 42
}

bridge Query.test {
  with myApi as t
  with output as o

  o.greeting <- t.greeting
  o.count <- t.count
}`,
      "Query.test",
      {},
      { echo },
    );
    assert.equal(data.greeting, "hello");
    assert.equal(data.count, 42);
  });

  // ── Simple pull from const ────────────────────────────────────────────────

  test("pull from const handle passes value to tool", async () => {
    const { data } = await run(
      `version 1.5
const apiUrl = "https://example.com"

tool myApi from echo {
  with const
  .url <- const.apiUrl
}

bridge Query.test {
  with myApi as t
  with output as o

  o.url <- t.url
}`,
      "Query.test",
      {},
      { echo },
    );
    assert.equal(data.url, "https://example.com");
  });

  // ── Expression chain (+ operator) ─────────────────────────────────────────

  test("expression chain: const + literal produces computed value", async () => {
    const { data } = await run(
      `version 1.5
const one = 1

tool myApi from echo {
  with const
  .limit <- const.one + 1
}

bridge Query.test {
  with myApi as t
  with output as o

  o.limit <- t.limit
}`,
      "Query.test",
      {},
      { echo },
    );
    assert.equal(data.limit, 2);
  });

  test("expression chain: const * literal produces computed value", async () => {
    const { data } = await run(
      `version 1.5
const base = 10

tool myApi from echo {
  with const
  .scaled <- const.base * 5
}

bridge Query.test {
  with myApi as t
  with output as o

  o.scaled <- t.scaled
}`,
      "Query.test",
      {},
      { echo },
    );
    assert.equal(data.scaled, 50);
  });

  test("expression chain: comparison operator", async () => {
    const { data } = await run(
      `version 1.5
const age = 21

tool myApi from echo {
  with const
  .eligible <- const.age >= 18
}

bridge Query.test {
  with myApi as t
  with output as o

  o.eligible <- t.eligible
}`,
      "Query.test",
      {},
      { echo },
    );
    assert.equal(data.eligible, true);
  });

  // ── String interpolation ──────────────────────────────────────────────────

  test("string interpolation in tool self-wire", async () => {
    const { data } = await run(
      `version 1.5
const city = "Berlin"

tool myApi from echo {
  with const
  .query <- "city={const.city}"
}

bridge Query.test {
  with myApi as t
  with output as o

  o.query <- t.query
}`,
      "Query.test",
      {},
      { echo },
    );
    assert.equal(data.query, "city=Berlin");
  });

  // ── Ternary ───────────────────────────────────────────────────────────────

  test("ternary with literal branches", async () => {
    const { data } = await run(
      `version 1.5
const flag = true

tool myApi from echo {
  with const
  .method <- const.flag ? "POST" : "GET"
}

bridge Query.test {
  with myApi as t
  with output as o

  o.method <- t.method
}`,
      "Query.test",
      {},
      { echo },
    );
    assert.equal(data.method, "POST");
  });

  // ── Coalesce ──────────────────────────────────────────────────────────────

  test("nullish coalesce with fallback value", async () => {
    const { data } = await run(
      `version 1.5
tool myApi from echo {
  with context
  .timeout <- context.settings.timeout ?? "5000"
}

bridge Query.test {
  with myApi as t
  with output as o

  o.timeout <- t.timeout
}`,
      "Query.test",
      {},
      { echo },
      { context: { settings: {} } },
    );
    assert.equal(data.timeout, "5000");
  });

  // ── Integration: the user's original example ──────────────────────────────

  test("httpCall-style tool with const + expression", async () => {
    const { data } = await run(
      `version 1.5
const one = 1

tool geo from fakeHttp {
  with const
  .baseUrl = "https://nominatim.openstreetmap.org"
  .path = "/search"
  .format = "json"
  .limit <- const.one + 1
}

bridge Query.location {
  with geo
  with input as i
  with output as o

  geo.q <- i.city
  o.result <- geo
}`,
      "Query.location",
      { city: "Zurich" },
      {
        fakeHttp: async (input: any) => {
          // Verify the tool received correct inputs
          return {
            baseUrl: input.baseUrl,
            path: input.path,
            format: input.format,
            limit: input.limit,
            q: input.q,
          };
        },
      },
    );
    assert.equal(data.result.baseUrl, "https://nominatim.openstreetmap.org");
    assert.equal(data.result.path, "/search");
    assert.equal(data.result.format, "json");
    assert.equal(data.result.limit, 2, "const.one + 1 should equal 2");
    assert.equal(data.result.q, "Zurich");
  });
});
