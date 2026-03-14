import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  parseBridgeFormat as parseBridge,
  serializeBridge,
} from "@stackables/bridge-parser";
import type { Bridge, ConstDef, ToolDef } from "@stackables/bridge-core";
import { assertDeepStrictEqualIgnoringLoc } from "./utils/parse-test-utils.ts";
import { bridge } from "@stackables/bridge-core";

// ══════════════════════════════════════════════════════════════════════════════
// 1. Const blocks — parser, serializer, roundtrip
// ══════════════════════════════════════════════════════════════════════════════

describe("parseBridge: const blocks", () => {
  test("single const with object value", () => {
    const doc = parseBridge(bridge`
      version 1.5
      const fallbackGeo = { "lat": 0, "lon": 0 }
    `);
    assert.equal(doc.instructions.length, 1);
    const c = doc.instructions.find((i): i is ConstDef => i.kind === "const")!;
    assert.equal(c.kind, "const");
    assert.equal(c.name, "fallbackGeo");
    assertDeepStrictEqualIgnoringLoc(JSON.parse(c.value), { lat: 0, lon: 0 });
  });

  test("single const with string value", () => {
    const c = parseBridge(bridge`
      version 1.5
      const currency = "EUR"
    `).instructions.find((i): i is ConstDef => i.kind === "const")!;
    assert.equal(c.name, "currency");
    assert.equal(JSON.parse(c.value), "EUR");
  });

  test("single const with number value", () => {
    const c = parseBridge(bridge`
      version 1.5
      const limit = 10
    `).instructions.find((i): i is ConstDef => i.kind === "const")!;
    assert.equal(c.name, "limit");
    assert.equal(JSON.parse(c.value), 10);
  });

  test("single const with null", () => {
    const c = parseBridge(bridge`
      version 1.5
      const empty = null
    `).instructions.find((i): i is ConstDef => i.kind === "const")!;
    assert.equal(JSON.parse(c.value), null);
  });

  test("multiple const declarations in one block", () => {
    const doc = parseBridge(bridge`
      version 1.5

      const fallbackGeo = { "lat": 0, "lon": 0 }
      const defaultCurrency = "EUR"
      const maxRetries = 3
    `);
    assert.equal(doc.instructions.length, 3);
    const consts = doc.instructions.filter(
      (i): i is ConstDef => i.kind === "const",
    );
    assert.equal(consts[0].name, "fallbackGeo");
    assert.equal(consts[1].name, "defaultCurrency");
    assert.equal(consts[2].name, "maxRetries");
  });

  test("multi-line JSON object", () => {
    const c = parseBridge(bridge`
      version 1.5
      const geo = {
        "lat": 0,
        "lon": 0
      }
    `).instructions.find((i): i is ConstDef => i.kind === "const")!;
    assertDeepStrictEqualIgnoringLoc(JSON.parse(c.value), { lat: 0, lon: 0 });
  });

  test("multi-line JSON array", () => {
    const c = parseBridge(bridge`
      version 1.5
      const items = [
        "a",
        "b",
        "c"
      ]
    `).instructions.find((i): i is ConstDef => i.kind === "const")!;
    assertDeepStrictEqualIgnoringLoc(JSON.parse(c.value), ["a", "b", "c"]);
  });

  test("const coexists with tool and bridge blocks", () => {
    const doc = parseBridge(bridge`
      version 1.5

      const fallback = { "lat": 0 }


      tool myApi from httpCall {
        .baseUrl = "https://example.com"

      }

      bridge Query.demo {
        with myApi as a
        with input as i
        with output as o

      o.result <- a.data

      }
    `);
    const consts = doc.instructions.filter((i) => i.kind === "const");
    const tools = doc.instructions.filter((i) => i.kind === "tool");
    const bridges = doc.instructions.filter((i) => i.kind === "bridge");
    assert.equal(consts.length, 1);
    assert.equal(tools.length, 1);
    assert.equal(bridges.length, 1);
  });

  test("invalid JSON throws", () => {
    assert.throws(
      () =>
        parseBridge(bridge`
          version 1.5
          const bad = { not valid json }
        `),
      /[Ii]nvalid JSON/,
    );
  });
});

describe("serializeBridge: const roundtrip", () => {
  test("const definitions roundtrip", () => {
    const input = bridge`
      version 1.5
      const fallbackGeo = {"lat":0,"lon":0}
      const currency = "EUR"


      bridge Query.demo {
        with input as i
        with output as o

      o.result <- i.q

      }
    `;
    const doc = parseBridge(input);
    const serialized = serializeBridge(doc);
    const reparsed = parseBridge(serialized);
    assertDeepStrictEqualIgnoringLoc(reparsed, doc);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. Tool on error — parser, serializer roundtrip
// ══════════════════════════════════════════════════════════════════════════════

describe("parseBridge: tool on error", () => {
  test("on error = <json> is parsed as onError wire with value", () => {
    const doc = parseBridge(bridge`
      version 1.5

      tool myApi from httpCall {
        on error = { "lat": 0, "lon": 0 }

      }
    `);
    const tool = doc.instructions.find((i): i is ToolDef => i.kind === "tool")!;
    const onError = tool.onError;
    assert.ok(onError, "should have an onError");
    assert.ok("value" in onError!, "should have a value");
    if ("value" in onError!) {
      assertDeepStrictEqualIgnoringLoc(JSON.parse(onError.value), {
        lat: 0,
        lon: 0,
      });
    }
  });

  test("on error <- source is parsed as onError wire with source", () => {
    const doc = parseBridge(bridge`
      version 1.5

      tool myApi from httpCall {
        with context
        on error <- context.fallbacks.geo

      }
    `);
    const tool = doc.instructions.find((i): i is ToolDef => i.kind === "tool")!;
    const onError = tool.onError;
    assert.ok(onError, "should have an onError");
    assert.ok("source" in onError!, "should have a source");
    if ("source" in onError!) {
      assert.equal(onError.source, "context.fallbacks.geo");
    }
  });

  test("on error multi-line JSON", () => {
    const doc = parseBridge(bridge`
      version 1.5

      tool myApi from httpCall {
        on error = {
          "lat": 0,
          "lon": 0
        }
      }
    `);
    const tool = doc.instructions.find((i): i is ToolDef => i.kind === "tool")!;
    const onError = tool.onError;
    assert.ok(onError && "value" in onError);
    if ("value" in onError!) {
      assertDeepStrictEqualIgnoringLoc(JSON.parse(onError.value), {
        lat: 0,
        lon: 0,
      });
    }
  });

  test("child tool inherits parent on error", () => {
    const doc = parseBridge(bridge`
      version 1.5

      tool base from httpCall {
        on error = { "fallback": true }

      }
      tool base.child from base {
        .method = GET

      }
    `);
    const base = doc.instructions.find(
      (i): i is ToolDef => i.kind === "tool" && i.name === "base",
    )!;
    assert.ok(base.onError);
  });
});

describe("serializeBridge: tool on error roundtrip", () => {
  test("on error = <json> roundtrips", () => {
    const input = bridge`
      version 1.5
      tool myApi from httpCall {
        on error = {"lat":0,"lon":0}

      }
    `;
    const doc = parseBridge(input);
    assertDeepStrictEqualIgnoringLoc(parseBridge(serializeBridge(doc)), doc);
  });

  test("on error <- source roundtrips", () => {
    const input = bridge`
      version 1.5
      tool myApi from httpCall {
        with context
        on error <- context.fallbacks.geo

      }
    `;
    const doc = parseBridge(input);
    assertDeepStrictEqualIgnoringLoc(parseBridge(serializeBridge(doc)), doc);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. Wire fallback (catch) — parser, serializer roundtrip
// ══════════════════════════════════════════════════════════════════════════════

describe("parseBridge: wire fallback (catch)", () => {
  test("catch adds catchFallback to pull wire", () => {
    const instr = parseBridge(bridge`
      version 1.5

      bridge Query.demo {
        with myApi as a
        with input as i
        with output as o

      a.q <- i.q
      o.lat <- a.lat catch 0

      }
    `).instructions.find((i): i is Bridge => i.kind === "bridge")!;

    const fbWire = instr.wires.find((w) => w.catch && "value" in w.catch);
    assert.ok(fbWire, "should have a wire with catch");
    assert.equal(
      "value" in fbWire!.catch! ? fbWire!.catch.value : undefined,
      "0",
    );
  });

  test("catch with JSON object catchFallback", () => {
    const instr = parseBridge(bridge`
      version 1.5

      bridge Query.demo {
        with myApi as a
        with input as i
        with output as o

      o.result <- a.data catch {"default":true}

      }
    `).instructions.find((i): i is Bridge => i.kind === "bridge")!;

    const fbWire = instr.wires.find((w) => w.catch && "value" in w.catch);
    assert.ok(fbWire);
    assert.equal(
      "value" in fbWire!.catch! ? fbWire!.catch.value : undefined,
      `{"default":true}`,
    );
  });

  test("catch with string catchFallback", () => {
    const instr = parseBridge(bridge`
      version 1.5

      bridge Query.demo {
        with myApi as a
        with input as i
        with output as o

      o.name <- a.name catch "unknown"

      }
    `).instructions.find((i): i is Bridge => i.kind === "bridge")!;

    const fbWire = instr.wires.find((w) => w.catch && "value" in w.catch);
    assert.ok(fbWire);
    assert.equal(
      "value" in fbWire!.catch! ? fbWire!.catch.value : undefined,
      `"unknown"`,
    );
  });

  test("catch with null catchFallback", () => {
    const instr = parseBridge(bridge`
      version 1.5

      bridge Query.demo {
        with myApi as a
        with input as i
        with output as o

      o.name <- a.name catch null

      }
    `).instructions.find((i): i is Bridge => i.kind === "bridge")!;

    const fbWire = instr.wires.find((w) => w.catch && "value" in w.catch);
    assert.ok(fbWire);
    assert.equal(
      "value" in fbWire!.catch! ? fbWire!.catch.value : undefined,
      "null",
    );
  });

  test("catch on pipe chain attaches to output wire", () => {
    const instr = parseBridge(bridge`
      version 1.5

      bridge Query.demo {
        with transform as t
        with input as i
        with output as o

      o.result <- t:i.text catch "fallback"

      }
    `).instructions.find((i): i is Bridge => i.kind === "bridge")!;

    const fbWire = instr.wires.find((w) => w.catch && "value" in w.catch);
    assert.ok(fbWire, "should have pipe output wire with catch");
    assert.equal(
      "value" in fbWire!.catch! ? fbWire!.catch.value : undefined,
      `"fallback"`,
    );
  });

  test("wires without catch have no catch property", () => {
    const instr = parseBridge(bridge`
      version 1.5

      bridge Query.demo {
        with myApi as a
        with input as i
        with output as o

      a.q <- i.q
      o.result <- a.data

      }
    `).instructions.find((i): i is Bridge => i.kind === "bridge")!;

    for (const w of instr.wires) {
      assert.equal(w.catch, undefined, "no catch on regular wire");
    }
  });
});

describe("serializeBridge: wire fallback roundtrip", () => {
  test("catch on regular wire roundtrips", () => {
    const input = bridge`
      version 1.5
      bridge Query.demo {
        with myApi as a
        with input as i
        with output as o

      a.q <- i.q
      o.lat <- a.lat catch 0

      }
    `;
    const doc = parseBridge(input);
    assertDeepStrictEqualIgnoringLoc(parseBridge(serializeBridge(doc)), doc);
  });

  test("catch on pipe chain roundtrips", () => {
    const input = bridge`
      version 1.5
      bridge Query.demo {
        with transform as t
        with input as i
        with output as o

      o.result <- t:i.text catch "fallback"

      }
    `;
    const doc = parseBridge(input);
    assertDeepStrictEqualIgnoringLoc(parseBridge(serializeBridge(doc)), doc);
  });

  test("serialized output contains catch", () => {
    const input = bridge`
      version 1.5
      bridge Query.demo {
        with myApi as a
        with input as i
        with output as o

      o.lat <- a.lat catch 0

      }
    `;
    const output = serializeBridge(parseBridge(input));
    assert.ok(
      output.includes("catch"),
      "serialized output should contain catch",
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. Wire || falsy-fallback — parser, serializer roundtrip
// ══════════════════════════════════════════════════════════════════════════════

describe("parseBridge: wire || falsy-fallback", () => {
  test("simple wire with || string literal", () => {
    const doc = parseBridge(bridge`
      version 1.5

      bridge Query.greet {
        with input as i
        with output as o

      o.name <- i.name || "World"

      }
    `);
    const instr = doc.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const wire = instr.wires[0]!;
    assert.equal(wire.sources.length, 2);
    assert.equal(wire.sources[1]!.gate, "falsy");
    assert.equal(
      wire.sources[1]!.expr.type === "literal"
        ? wire.sources[1]!.expr.value
        : undefined,
      '"World"',
    );
    assert.equal(wire.catch, undefined);
  });

  test("wire with both || and catch", () => {
    const doc = parseBridge(bridge`
      version 1.5

      bridge Query.greet {
        with input as i
        with output as o

      o.name <- i.name || "World" catch "Error"

      }
    `);
    const instr = doc.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const wire = instr.wires[0]!;
    assert.equal(wire.sources.length, 2);
    assert.equal(wire.sources[1]!.gate, "falsy");
    assert.equal(
      wire.sources[1]!.expr.type === "literal"
        ? wire.sources[1]!.expr.value
        : undefined,
      '"World"',
    );
    assert.ok(wire.catch && "value" in wire.catch);
    assert.equal(wire.catch.value, '"Error"');
  });

  test("wire with || JSON object literal", () => {
    const doc = parseBridge(bridge`
      version 1.5

      bridge Query.geo {
        with api as a
        with input as i
        with output as o

      a.q <- i.q
      o.result <- a.data || {"lat":0,"lon":0}

      }
    `);
    const instr = doc.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const wire = instr.wires.find(
      (w) =>
        w.sources[0]?.expr.type === "ref" &&
        w.sources[0].expr.ref.path[0] === "data",
    )!;
    assert.equal(wire.sources.length, 2);
    assert.equal(wire.sources[1]!.gate, "falsy");
    assert.equal(
      wire.sources[1]!.expr.type === "literal"
        ? wire.sources[1]!.expr.value
        : undefined,
      '{"lat":0,"lon":0}',
    );
  });

  test("wire without || has no fallbacks", () => {
    const doc = parseBridge(bridge`
      version 1.5

      bridge Query.greet {
        with input as i
        with output as o

      o.name <- i.name

      }
    `);
    const instr = doc.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const wire = instr.wires[0]!;
    assert.equal(wire.sources.length, 1, "should have no fallback sources");
  });

  test("pipe wire with || falsy-fallback", () => {
    const doc = parseBridge(bridge`
      version 1.5

      bridge Query.format {
        with std.str.toUpperCase as up
        with input as i
        with output as o

      o.result <- up:i.text || "N/A"

      }
    `);
    const instr = doc.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const terminalWire = instr.wires.find(
      (w) =>
        w.pipe &&
        w.sources[0]?.expr.type === "ref" &&
        w.sources[0].expr.ref.path.length === 0,
    )!;
    assert.equal(terminalWire.sources.length, 2);
    assert.equal(terminalWire.sources[1]!.gate, "falsy");
    assert.equal(
      terminalWire.sources[1]!.expr.type === "literal"
        ? terminalWire.sources[1]!.expr.value
        : undefined,
      '"N/A"',
    );
  });
});

describe("serializeBridge: || falsy-fallback roundtrip", () => {
  test("|| string literal roundtrips", () => {
    const input = bridge`
      version 1.5
      bridge Query.greet {
        with input as i
        with output as o

      o.name <- i.name || "World"

      }
    `;
    const reparsed = parseBridge(serializeBridge(parseBridge(input)));
    const original = parseBridge(input);
    assertDeepStrictEqualIgnoringLoc(reparsed, original);
  });

  test("|| and catch together roundtrip", () => {
    const input = bridge`
      version 1.5
      bridge Query.greet {
        with myApi as a
        with input as i
        with output as o

      a.q <- i.q
      o.name <- a.name || "World" catch "Error"

      }
    `;
    const reparsed = parseBridge(serializeBridge(parseBridge(input)));
    const original = parseBridge(input);
    assertDeepStrictEqualIgnoringLoc(reparsed, original);
  });

  test("pipe wire with || roundtrips", () => {
    const input = bridge`
      version 1.5
      bridge Query.format {
        with std.str.toUpperCase as up
        with input as i
        with output as o

      o.result <- up:i.text || "N/A"

      }
    `;
    const reparsed = parseBridge(serializeBridge(parseBridge(input)));
    const original = parseBridge(input);
    assertDeepStrictEqualIgnoringLoc(reparsed, original);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. || source references — parser
// ══════════════════════════════════════════════════════════════════════════════

describe("parseBridge: || source references", () => {
  test("|| source produces one wire with fallbacks", () => {
    const doc = parseBridge(bridge`
      version 1.5

      bridge Query.lookup {
        with primary as p
        with backup as b
        with input as i
        with output as o

      p.q <- i.q
      b.q <- i.q
      o.label <- p.label || b.label

      }
    `);
    const instr = doc.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const labelWires = instr.wires.filter((w) => w.to.path[0] === "label");
    assert.equal(labelWires.length, 1, "should be one wire, not two");
    assert.ok(
      labelWires[0].sources.length >= 2,
      "should have fallback sources",
    );
    assert.equal(labelWires[0].sources[1]!.gate, "falsy");
    const fb0Expr = labelWires[0].sources[1]!.expr;
    assert.deepEqual(fb0Expr.type === "ref" ? fb0Expr.ref.path : undefined, [
      "label",
    ]);
    assert.equal(labelWires[0].catch, undefined);
  });

  test("|| source || literal — one wire with fallbacks", () => {
    const doc = parseBridge(bridge`
      version 1.5

      bridge Query.lookup {
        with a as a
        with b as b
        with input as i
        with output as o

      a.q <- i.q
      b.q <- i.q
      o.label <- a.label || b.label || "default"

      }
    `);
    const instr = doc.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const labelWires = instr.wires.filter((w) => w.to.path[0] === "label");
    assert.equal(labelWires.length, 1);
    assert.ok(
      labelWires[0].sources.length >= 3,
      "should have 2 fallback sources",
    );
    assert.equal(labelWires[0].sources[1]!.gate, "falsy");
    assert.equal(labelWires[0].sources[1]!.expr.type, "ref");
    assert.equal(labelWires[0].sources[2]!.gate, "falsy");
    assert.equal(
      labelWires[0].sources[2]!.expr.type === "literal"
        ? labelWires[0].sources[2]!.expr.value
        : undefined,
      '"default"',
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. catch source/pipe references — parser
// ══════════════════════════════════════════════════════════════════════════════

describe("parseBridge: catch source/pipe references", () => {
  test("catch source.path stores a catchFallbackRef NodeRef", () => {
    const doc = parseBridge(bridge`
      version 1.5

      bridge Query.lookup {
        with myApi as api
        with input as i
        with output as o

      api.q <- i.q
      o.label <- api.label catch i.fallbackLabel

      }
    `);
    const instr = doc.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const wire = instr.wires.find((w) => w.to.path[0] === "label")!;
    assert.ok(wire.catch && "ref" in wire.catch, "should have catch ref");
    assert.equal(
      wire.catch && "value" in wire.catch ? wire.catch.value : undefined,
      undefined,
      "should not have JSON catch value",
    );
    assert.deepEqual("ref" in wire.catch ? wire.catch.ref.path : undefined, [
      "fallbackLabel",
    ]);
  });

  test("catch pipe:source stores catchFallbackRef pointing to fork root + registers fork", () => {
    const doc = parseBridge(bridge`
      version 1.5

      bridge Query.lookup {
        with myApi as api
        with std.str.toUpperCase as up
        with input as i
        with output as o

      api.q <- i.q
      o.label <- api.label catch up:i.errorDefault

      }
    `);
    const instr = doc.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const wire = instr.wires.find((w) => !w.pipe && w.to.path[0] === "label")!;
    assert.ok(wire.catch && "ref" in wire.catch, "should have catch ref");
    assert.deepEqual(wire.catch.ref.path, []);
    assert.ok(
      instr.pipeHandles && instr.pipeHandles.length > 0,
      "should have pipe forks",
    );
  });

  test("full chain: A || B || literal catch source — one wire with fallbacks + catchFallbackRef", () => {
    const doc = parseBridge(bridge`
      version 1.5

      bridge Query.lookup {
        with primary as p
        with backup as b
        with input as i
        with output as o

      p.q <- i.q
      b.q <- i.q
      o.label <- p.label || b.label || "default" catch i.errorLabel

      }
    `);
    const instr = doc.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const labelWires = instr.wires.filter(
      (w) => !w.pipe && w.to.path[0] === "label",
    );
    assert.equal(labelWires.length, 1);
    assert.ok(
      labelWires[0].sources.length >= 3,
      "should have fallback sources",
    );
    assert.equal(labelWires[0].sources[1]!.gate, "falsy");
    assert.equal(labelWires[0].sources[1]!.expr.type, "ref");
    assert.equal(labelWires[0].sources[2]!.gate, "falsy");
    assert.equal(
      labelWires[0].sources[2]!.expr.type === "literal"
        ? labelWires[0].sources[2]!.expr.value
        : undefined,
      '"default"',
    );
    assert.ok(
      labelWires[0].catch && "ref" in labelWires[0].catch,
      "wire should have catch ref",
    );
    assert.equal(
      labelWires[0].catch && "value" in labelWires[0].catch
        ? labelWires[0].catch.value
        : undefined,
      undefined,
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 7. catch source/pipe roundtrip — serializer
// ══════════════════════════════════════════════════════════════════════════════

describe("serializeBridge: catch source/pipe roundtrip", () => {
  test("catch source.path roundtrips", () => {
    const input = bridge`
      version 1.5
      bridge Query.lookup {
        with myApi as api
        with input as i
        with output as o

      api.q <- i.q
      o.label <- api.label catch i.fallbackLabel

      }
    `;
    const reparsed = parseBridge(serializeBridge(parseBridge(input)));
    assertDeepStrictEqualIgnoringLoc(reparsed, parseBridge(input));
  });

  test("catch pipe:source roundtrips", () => {
    const input = bridge`
      version 1.5
      bridge Query.lookup {
        with myApi as api
        with std.str.toUpperCase as up
        with input as i
        with output as o

      api.q <- i.q
      o.label <- api.label catch up:i.errorDefault

      }
    `;
    const reparsed = parseBridge(serializeBridge(parseBridge(input)));
    assertDeepStrictEqualIgnoringLoc(reparsed, parseBridge(input));
  });

  test("|| source || source roundtrips (desugars to multi-wire)", () => {
    const input = bridge`
      version 1.5
      bridge Query.lookup {
        with primary as p
        with backup as b
        with input as i
        with output as o

      p.q <- i.q
      b.q <- i.q
      o.label <- p.label || b.label || "default"

      }
    `;
    const reparsed = parseBridge(serializeBridge(parseBridge(input)));
    assertDeepStrictEqualIgnoringLoc(reparsed, parseBridge(input));
  });

  test("full chain: || source || literal catch pipe roundtrips", () => {
    const input = bridge`
      version 1.5
      bridge Query.lookup {
        with myApi as api
        with backup as b
        with std.str.toUpperCase as up
        with input as i
        with output as o

      api.q <- i.q
      b.q <- i.q
      o.label <- api.label || b.label || "default" catch up:i.errorDefault

      }
    `;
    const reparsed = parseBridge(serializeBridge(parseBridge(input)));
    assertDeepStrictEqualIgnoringLoc(reparsed, parseBridge(input));
  });
});
