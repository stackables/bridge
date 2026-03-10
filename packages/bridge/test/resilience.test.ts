/**
 * Resilience features — end-to-end execution tests.
 *
 * Covers: const in bridge, tool on error, wire catch, || falsy-fallback,
 * multi-wire null-coalescing, || source references, catch source/pipe references.
 *
 * Migrated from bridge-graphql/test/resilience.test.ts — converted from
 * GraphQL gateway tests to direct executeBridge via forEachEngine.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { forEachEngine } from "./utils/dual-run.ts";

// ══════════════════════════════════════════════════════════════════════════════
// 1. Const in bridge — with const as c, wiring c.value
// ══════════════════════════════════════════════════════════════════════════════

forEachEngine("const in bridge: end-to-end", (run) => {
  test("bridge can read const values", async () => {
    const { data } = await run(
      `version 1.5
const defaults = { "currency": "EUR", "maxItems": 100 }


bridge Query.info {
  with const as c
  with output as o

o.currency <- c.defaults.currency
o.maxItems <- c.defaults.maxItems

}`,
      "Query.info",
      {},
    );

    assert.equal(data.currency, "EUR");
    assert.equal(data.maxItems, 100);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. Tool on error — end-to-end
// ══════════════════════════════════════════════════════════════════════════════

forEachEngine("tool on error: end-to-end", (run, { engine }) => {
  test(
    "on error = <json> returns fallback when tool throws",
    { skip: engine === "compiled" },
    async () => {
      const { data } = await run(
        `version 1.5
tool flakyApi from httpCall {
  on error = { "lat": 0, "lon": 0 }

}

bridge Query.geo {
  with flakyApi as api
  with input as i
  with output as o

api.q <- i.q
o.lat <- api.lat
o.lon <- api.lon

}`,
        "Query.geo",
        { q: "Berlin" },
        {
          httpCall: async () => {
            throw new Error("Service unavailable");
          },
        },
      );

      assert.equal(data.lat, 0);
      assert.equal(data.lon, 0);
    },
  );

  test(
    "on error <- context returns context fallback when tool throws",
    { skip: engine === "compiled" },
    async () => {
      const { data } = await run(
        `version 1.5
tool flakyApi from httpCall {
  with context
  on error <- context.fallbacks.geo

}

bridge Query.geo {
  with flakyApi as api
  with input as i
  with output as o

api.q <- i.q
o.lat <- api.lat
o.lon <- api.lon

}`,
        "Query.geo",
        { q: "Berlin" },
        {
          httpCall: async () => {
            throw new Error("Service unavailable");
          },
        },
        { context: { fallbacks: { geo: { lat: 52.52, lon: 13.4 } } } },
      );

      assert.equal(data.lat, 52.52);
      assert.equal(data.lon, 13.4);
    },
  );

  test(
    "on error is NOT used when tool succeeds",
    { skip: engine === "compiled" },
    async () => {
      const { data } = await run(
        `version 1.5
tool api from httpCall {
  on error = { "lat": 0, "lon": 0 }

}

bridge Query.geo {
  with api
  with input as i
  with output as o

api.q <- i.q
o.lat <- api.lat
o.lon <- api.lon

}`,
        "Query.geo",
        { q: "Berlin" },
        {
          httpCall: async () => ({ lat: 52.52, lon: 13.4 }),
        },
      );

      assert.equal(data.lat, 52.52);
      assert.equal(data.lon, 13.4);
    },
  );

  test(
    "child inherits parent on error through extends chain",
    { skip: engine === "compiled" },
    async () => {
      const { data } = await run(
        `version 1.5
tool base from httpCall {
  on error = { "lat": 0, "lon": 0 }

}
tool base.child from base {
  .method = GET
  .path = /geocode

}

bridge Query.geo {
  with base.child as api
  with input as i
  with output as o

api.q <- i.q
o.lat <- api.lat
o.lon <- api.lon

}`,
        "Query.geo",
        { q: "Berlin" },
        {
          httpCall: async () => {
            throw new Error("timeout");
          },
        },
      );

      assert.equal(data.lat, 0);
      assert.equal(data.lon, 0);
    },
  );
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. Wire fallback (catch) — end-to-end
// ══════════════════════════════════════════════════════════════════════════════

forEachEngine("wire fallback: end-to-end", (run) => {
  test("catch returns catchFallback when entire chain fails", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.lookup {
  with myApi as api
  with input as i
  with output as o

api.q <- i.q
o.lat <- api.lat catch 0
o.name <- api.name catch "unknown"

}`,
      "Query.lookup",
      { q: "test" },
      {
        myApi: async () => {
          throw new Error("down");
        },
      },
    );

    assert.equal(data.lat, 0);
    assert.equal(data.name, "unknown");
  });

  test("catch is NOT used when source succeeds", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.lookup {
  with myApi as api
  with input as i
  with output as o

api.q <- i.q
o.lat <- api.lat catch 0
o.name <- api.name catch "unknown"

}`,
      "Query.lookup",
      { q: "test" },
      {
        myApi: async () => ({ lat: 52.52, name: "Berlin" }),
      },
    );

    assert.equal(data.lat, 52.52);
    assert.equal(data.name, "Berlin");
  });

  test("catch catches chain failure (dep tool fails)", async () => {
    const { data } = await run(
      `version 1.5
tool flakyGeo from httpCall {
  .baseUrl = "https://broken.test"

}

bridge Query.lookup {
  with flakyGeo as geo
  with input as i
  with output as o

geo.q <- i.q
o.lat <- geo.lat catch -999
o.name <- geo.name catch "N/A"

}`,
      "Query.lookup",
      { q: "test" },
      {
        httpCall: async () => {
          throw new Error("network");
        },
      },
    );

    assert.equal(data.lat, -999);
    assert.equal(data.name, "N/A");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. Combined: on error + catch + const
// ══════════════════════════════════════════════════════════════════════════════

forEachEngine("combined: on error + catch + const", (run, { engine }) => {
  test(
    "on error provides tool fallback, catch provides wire catchFallback as last resort",
    { skip: engine === "compiled" },
    async () => {
      // Tool has on error, so lat/lon come from there.
      // 'extra' has no tool fallback but has wire catch
      const { data } = await run(
        `version 1.5
tool geo from httpCall {
  on error = { "lat": 0, "lon": 0 }

}

bridge Query.search {
  with geo
  with badApi as bad
  with input as i
  with output as o

geo.q <- i.q
o.lat <- geo.lat
o.lon <- geo.lon
bad.q <- i.q
o.extra <- bad.data catch "none"

}`,
        "Query.search",
        { q: "test" },
        {
          httpCall: async () => {
            throw new Error("down");
          },
          badApi: async () => {
            throw new Error("also down");
          },
        },
      );

      // geo tool's on error kicks in
      assert.equal(data.lat, 0);
      assert.equal(data.lon, 0);
      // badApi has no on error, but wire catch catches
      assert.equal(data.extra, "none");
    },
  );
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. Wire || falsy-fallback — end-to-end
// ══════════════════════════════════════════════════════════════════════════════

forEachEngine("wire || falsy-fallback: end-to-end", (run) => {
  test("|| returns literal when field is falsy", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.greet {
  with input as i
  with output as o

o.message <- i.name || "World"

}`,
      "Query.greet",
      { name: null },
    );
    assert.equal(data.message, "World");
  });

  test("|| is skipped when field has a value", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.greet {
  with input as i
  with output as o

o.message <- i.name || "World"

}`,
      "Query.greet",
      { name: "Alice" },
    );
    assert.equal(data.message, "Alice");
  });

  test("|| falsy-fallback fires when tool returns null field", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.lookup {
  with myApi as api
  with input as i
  with output as o

api.q <- i.q
o.label <- api.label || "unknown"
o.score <- api.score || 0

}`,
      "Query.lookup",
      { q: "test" },
      {
        myApi: async () => ({ label: null, score: null }),
      },
    );
    assert.equal(data.label, "unknown");
    assert.equal(data.score, 0);
  });

  test("|| and catch compose: || fires on falsy, catch fires on error", async () => {
    const { data: d1 } = await run(
      `version 1.5
bridge Query.lookup {
  with myApi as api
  with input as i
  with output as o

api.q <- i.q
api.fail <- i.fail
o.label <- api.label || "null-default" catch "error-default"

}`,
      "Query.lookup",
      { q: "test", fail: false },
      {
        myApi: async (input: any) => {
          if (input.fail) throw new Error("boom");
          return { label: null };
        },
      },
    );
    // falsy case (null) → || fires
    assert.equal(d1.label, "null-default");

    const { data: d2 } = await run(
      `version 1.5
bridge Query.lookup {
  with myApi as api
  with input as i
  with output as o

api.q <- i.q
api.fail <- i.fail
o.label <- api.label || "null-default" catch "error-default"

}`,
      "Query.lookup",
      { q: "test", fail: true },
      {
        myApi: async (input: any) => {
          if (input.fail) throw new Error("boom");
          return { label: null };
        },
      },
    );
    // error case → catch fires
    assert.equal(d2.label, "error-default");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. Multi-wire null-coalescing — end-to-end
// ══════════════════════════════════════════════════════════════════════════════

forEachEngine("multi-wire null-coalescing: end-to-end", (run) => {
  test("first wire wins when it has a value", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.email {
  with std.str.toUpperCase as up
  with input as i
  with output as o

o.textPart <- i.textBody
o.textPart <- up:i.htmlBody

}`,
      "Query.email",
      { textBody: "plain text", htmlBody: "<b>bold</b>" },
    );
    assert.equal(data.textPart, "plain text");
  });

  test("second wire used when first is null", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.email {
  with std.str.toUpperCase as up
  with input as i
  with output as o

o.textPart <- i.textBody
o.textPart <- up:i.htmlBody

}`,
      "Query.email",
      { textBody: null, htmlBody: "hello" },
    );
    // textBody is null → fall through to upperCase(htmlBody)
    assert.equal(data.textPart, "HELLO");
  });

  test("multi-wire + || terminal literal as last resort", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.email {
  with input as i
  with output as o

o.textPart <- i.textBody
o.textPart <- i.htmlBody || "empty"

}`,
      "Query.email",
      { textBody: null, htmlBody: null },
    );
    // Both null → || literal fires
    assert.equal(data.textPart, "empty");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 7. || source + catch source — end-to-end
// ══════════════════════════════════════════════════════════════════════════════

forEachEngine("|| source + catch source: end-to-end", (run, { engine }) => {
  test(
    "|| source: primary null → backup used",
    { skip: engine === "compiled" },
    async () => {
      const { data } = await run(
        `version 1.5
bridge Query.lookup {
  with primary as p
  with backup as b
  with input as i
  with output as o

p.q <- i.q
b.q <- i.q
o.label <- p.label || b.label

}`,
        "Query.lookup",
        { q: "x" },
        {
          primary: async () => ({ label: null }),
          backup: async () => ({ label: "from-backup" }),
        },
      );
      assert.equal(data.label, "from-backup");
    },
  );

  test(
    "|| source: primary has value → backup never called",
    { skip: engine === "compiled" },
    async () => {
      let backupCalled = false;
      const { data } = await run(
        `version 1.5
bridge Query.lookup {
  with primary as p
  with backup as b
  with input as i
  with output as o

p.q <- i.q
b.q <- i.q
o.label <- p.label || b.label

}`,
        "Query.lookup",
        { q: "x" },
        {
          primary: async () => ({ label: "from-primary" }),
          backup: async () => {
            backupCalled = true;
            return { label: "from-backup" };
          },
        },
      );
      assert.equal(data.label, "from-primary");
      // v2.0: sequential short-circuit — backup is never called when primary succeeds
      assert.equal(
        backupCalled,
        false,
        "backup should NOT be called when primary returns non-falsy",
      );
    },
  );

  test(
    "|| source || literal: both null → literal fires",
    { skip: engine === "compiled" },
    async () => {
      const { data } = await run(
        `version 1.5
bridge Query.lookup {
  with primary as p
  with backup as b
  with input as i
  with output as o

p.q <- i.q
b.q <- i.q
o.label <- p.label || b.label || "nothing found"

}`,
        "Query.lookup",
        { q: "x" },
        {
          primary: async () => ({ label: null }),
          backup: async () => ({ label: null }),
        },
      );
      assert.equal(data.label, "nothing found");
    },
  );

  test("catch source.path: all throw → pull from input field", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.lookup {
  with myApi as api
  with input as i
  with output as o

api.q <- i.q
o.label <- api.label catch i.defaultLabel

}`,
      "Query.lookup",
      { q: "x", defaultLabel: "fallback-value" },
      {
        myApi: async () => {
          throw new Error("down");
        },
      },
    );
    assert.equal(data.label, "fallback-value");
  });

  test("catch pipe:source: all throw → pipe tool applied to input field", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.lookup {
  with myApi as api
  with std.str.toUpperCase as up
  with input as i
  with output as o

api.q <- i.q
o.label <- api.label catch up:i.errorDefault

}`,
      "Query.lookup",
      { q: "x", errorDefault: "service unavailable" },
      {
        myApi: async () => {
          throw new Error("down");
        },
      },
    );
    // std.str.toUpperCase applied to "service unavailable"
    assert.equal(data.label, "SERVICE UNAVAILABLE");
  });

  test(
    "full COALESCE: A || B || literal catch source — all layers",
    { skip: engine === "compiled" },
    async () => {
      // Both return null → || literal fires
      const { data: d1 } = await run(
        `version 1.5
bridge Query.lookup {
  with primary as p
  with backup as b
  with input as i
  with output as o

p.q <- i.q
p.fail <- i.fail
b.q <- i.q
b.fail <- i.fail
o.label <- p.label || b.label || "nothing" catch i.defaultLabel

}`,
        "Query.lookup",
        { q: "x", fail: false, defaultLabel: "err" },
        {
          primary: async (inp: any) => {
            if (inp.fail) throw new Error("primary down");
            return { label: null };
          },
          backup: async (inp: any) => {
            if (inp.fail) throw new Error("backup down");
            return { label: null };
          },
        },
      );
      assert.equal(d1.label, "nothing");

      // Both throw → catch source fires
      const { data: d2 } = await run(
        `version 1.5
bridge Query.lookup {
  with primary as p
  with backup as b
  with input as i
  with output as o

p.q <- i.q
p.fail <- i.fail
b.q <- i.q
b.fail <- i.fail
o.label <- p.label || b.label || "nothing" catch i.defaultLabel

}`,
        "Query.lookup",
        { q: "x", fail: true, defaultLabel: "error-default" },
        {
          primary: async (inp: any) => {
            if (inp.fail) throw new Error("primary down");
            return { label: null };
          },
          backup: async (inp: any) => {
            if (inp.fail) throw new Error("backup down");
            return { label: null };
          },
        },
      );
      assert.equal(d2.label, "error-default");
    },
  );
});
