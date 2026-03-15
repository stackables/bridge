import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  parseBridgeFormat as parseBridge,
  serializeBridge,
} from "../src/index.ts";
import type { Bridge } from "@stackables/bridge-core";
import { assertDeepStrictEqualIgnoringLoc } from "./utils/parse-test-utils.ts";
import { bridge } from "@stackables/bridge-core";

// ── Parser tests ────────────────────────────────────────────────────────────

describe("path scoping – parser", () => {
  test("simple scope block with constants", () => {
    const result = parseBridge(bridge`
      version 1.5

      bridge Query.test {
        with output as o

        o.settings {
          .theme = "dark"
          .lang = "en"
        }
      }
    `);
    const instr = result.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    assert.ok(instr);
    const constWires = instr.wires.filter(
      (w) => w.sources[0]?.expr.type === "literal",
    );
    assert.equal(constWires.length, 2);
    const theme = constWires.find(
      (w) => w.to.path.join(".") === "settings.theme",
    );
    const lang = constWires.find(
      (w) => w.to.path.join(".") === "settings.lang",
    );
    assert.ok(theme);
    assert.equal(
      theme.sources[0]!.expr.type === "literal"
        ? theme.sources[0]!.expr.value
        : undefined,
      "dark",
    );
    assert.ok(lang);
    assert.equal(
      lang.sources[0]!.expr.type === "literal"
        ? lang.sources[0]!.expr.value
        : undefined,
      "en",
    );
  });

  test("scope block with pull wires", () => {
    const result = parseBridge(bridge`
      version 1.5

      bridge Query.test {
        with input as i
        with output as o

        o.user {
          .name <- i.name
          .email <- i.email
        }
      }
    `);
    const instr = result.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const pullWires = instr.wires.filter(
      (w) => w.sources[0]?.expr.type === "ref",
    );
    assert.equal(pullWires.length, 2);
    const nameWire = pullWires.find((w) => w.to.path.join(".") === "user.name");
    const emailWire = pullWires.find(
      (w) => w.to.path.join(".") === "user.email",
    );
    assert.ok(nameWire);
    const nameExpr = nameWire.sources[0]!.expr;
    assertDeepStrictEqualIgnoringLoc(
      nameExpr.type === "ref" ? nameExpr.ref.path : undefined,
      ["name"],
    );
    assert.ok(emailWire);
    const emailExpr = emailWire.sources[0]!.expr;
    assertDeepStrictEqualIgnoringLoc(
      emailExpr.type === "ref" ? emailExpr.ref.path : undefined,
      ["email"],
    );
  });

  test("nested scope blocks", () => {
    const result = parseBridge(bridge`
      version 1.5

      bridge Query.test {
        with input as i
        with output as o

        o.body.user {
          .profile {
            .id <- i.id
            .name <- i.name
          }
          .settings {
            .theme = "dark"
            .notifications = true
          }
        }
      }
    `);
    const instr = result.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const wires = instr.wires;

    // Pull wires
    const pullWires = wires.filter((w) => w.sources[0]?.expr.type === "ref");
    const idWire = pullWires.find(
      (w) => w.to.path.join(".") === "body.user.profile.id",
    );
    const nameWire = pullWires.find(
      (w) => w.to.path.join(".") === "body.user.profile.name",
    );
    assert.ok(idWire, "id wire should exist");
    assert.ok(nameWire, "name wire should exist");
    const idExpr = idWire.sources[0]!.expr;
    assertDeepStrictEqualIgnoringLoc(
      idExpr.type === "ref" ? idExpr.ref.path : undefined,
      ["id"],
    );
    const nameExpr2 = nameWire.sources[0]!.expr;
    assertDeepStrictEqualIgnoringLoc(
      nameExpr2.type === "ref" ? nameExpr2.ref.path : undefined,
      ["name"],
    );

    // Constant wires
    const constWires = wires.filter(
      (w) => w.sources[0]?.expr.type === "literal",
    );
    const themeWire = constWires.find(
      (w) => w.to.path.join(".") === "body.user.settings.theme",
    );
    const notifWire = constWires.find(
      (w) => w.to.path.join(".") === "body.user.settings.notifications",
    );
    assert.ok(themeWire);
    assert.equal(
      themeWire.sources[0]!.expr.type === "literal"
        ? themeWire.sources[0]!.expr.value
        : undefined,
      "dark",
    );
    assert.ok(notifWire);
    assert.equal(
      notifWire.sources[0]!.expr.type === "literal"
        ? notifWire.sources[0]!.expr.value
        : undefined,
      "true",
    );
  });

  test("scope block with pipe operator", () => {
    const result = parseBridge(bridge`
      version 1.5

      bridge Query.test {
        with std.str.toUpperCase as uc
        with input as i
        with output as o

        o.profile {
          .name <- uc:i.name
          .id <- i.id
        }
      }
    `);
    const instr = result.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    assert.ok(instr.pipeHandles && instr.pipeHandles.length > 0);
  });

  test("scope block with fallback operators", () => {
    const result = parseBridge(bridge`
      version 1.5

      bridge Query.test {
        with input as i
        with output as o

        o.data {
          .name <- i.name || "anonymous"
          .value <- i.value catch 0
        }
      }
    `);
    const instr = result.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const pullWires = instr.wires.filter(
      (w) => w.sources[0]?.expr.type === "ref",
    );
    const nameWire = pullWires.find((w) => w.to.path.join(".") === "data.name");
    assert.ok(nameWire);
    assert.equal(nameWire.sources.length, 2);
    assert.equal(nameWire.sources[1]!.gate, "falsy");
    assert.equal(
      nameWire.sources[1]!.expr.type === "literal"
        ? nameWire.sources[1]!.expr.value
        : undefined,
      '"anonymous"',
    );

    const valueWire = pullWires.find(
      (w) => w.to.path.join(".") === "data.value",
    );
    assert.ok(valueWire);
    assert.equal(
      valueWire.catch && "value" in valueWire.catch
        ? valueWire.catch.value
        : undefined,
      "0",
    );
  });

  test("scope block with expression", () => {
    const result = parseBridge(bridge`
      version 1.5

      bridge Query.test {
        with input as i
        with output as o

        o.pricing {
          .cents <- i.dollars * 100
          .eligible <- i.amount >= 50
        }
      }
    `);
    const instr = result.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    assert.ok(instr.pipeHandles && instr.pipeHandles.length > 0);
  });

  test("scope block with ternary", () => {
    const result = parseBridge(bridge`
      version 1.5

      bridge Query.test {
        with input as i
        with output as o

        o.result {
          .tier <- i.isPro ? "premium" : "basic"
          .price <- i.isPro ? i.proPrice : i.basicPrice
        }
      }
    `);
    const instr = result.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const ternaryWires = instr.wires.filter(
      (w) => w.sources[0]?.expr.type === "ternary",
    );
    assert.equal(ternaryWires.length, 2);
  });

  test("scope block with string interpolation", () => {
    const result = parseBridge(bridge`
      version 1.5

      bridge Query.test {
        with input as i
        with output as o

        o.display {
          .greeting <- "Hello, {i.name}!"
          .url <- "/users/{i.id}/profile"
        }
      }
    `);
    const instr = result.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    assert.ok(instr.pipeHandles && instr.pipeHandles.length > 0);
  });

  test("mixed flat wires and scope blocks", () => {
    const result = parseBridge(bridge`
      version 1.5

      bridge Query.test {
        with input as i
        with output as o

        o.method = "POST"
        o.body {
          .name <- i.name
          .value = "test"
        }
        o.status = true
      }
    `);
    const instr = result.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const constWires = instr.wires.filter(
      (w) => w.sources[0]?.expr.type === "literal",
    );
    assert.equal(constWires.length, 3);
    assert.ok(constWires.find((w) => w.to.path.join(".") === "method"));
    assert.ok(constWires.find((w) => w.to.path.join(".") === "body.value"));
    assert.ok(constWires.find((w) => w.to.path.join(".") === "status"));
  });

  test("scope block on tool handle", () => {
    const result = parseBridge(bridge`
      version 1.5

      tool api from std.httpCall {
        .baseUrl = "https://api.example.com"
        .method = POST
      }

      bridge Mutation.createUser {
        with api
        with input as i
        with output as o

        api.body {
          .name <- i.name
          .email <- i.email
        }
        o.success = true
      }
    `);
    const instr = result.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const pullWires = instr.wires.filter(
      (w) => w.sources[0]?.expr.type === "ref",
    );
    const nameWire = pullWires.find((w) => w.to.path.join(".") === "body.name");
    const emailWire = pullWires.find(
      (w) => w.to.path.join(".") === "body.email",
    );
    assert.ok(nameWire, "name wire targeting api.body.name should exist");
    assert.ok(emailWire, "email wire targeting api.body.email should exist");
  });

  test("scope blocks produce same wires as flat syntax", () => {
    const scopedResult = parseBridge(bridge`
      version 1.5

      bridge Query.test {
        with input as i
        with output as o

        o.user {
          .profile {
            .id <- i.id
            .name <- i.name
          }
          .settings {
            .theme = "dark"
          }
        }
      }
    `);

    const flatResult = parseBridge(bridge`
      version 1.5

      bridge Query.test {
        with input as i
        with output as o

        o.user.profile.id <- i.id
        o.user.profile.name <- i.name
        o.user.settings.theme = "dark"
      }
    `);

    const scopedBridge = scopedResult.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const flatBridge = flatResult.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;

    assertDeepStrictEqualIgnoringLoc(scopedBridge.wires, flatBridge.wires);
  });

  test("scope block on tool input wires to tool correctly", () => {
    const instr = bridge`
      version 1.5

      tool api from std.httpCall {
        .baseUrl = "https://nominatim.openstreetmap.org"
        .method = GET
        .path = "/search"
      }

      bridge Query.test {
        with api
        with input as i
        with output as o

        api {
          .q <- i.city
        }
        o.success = true
      }
    `;
    const parsed = parseBridge(instr);
    const br = parsed.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const pullWires = br.wires.filter((w) => w.sources[0]?.expr.type === "ref");
    const qWire = pullWires.find((w) => w.to.path.join(".") === "q");
    assert.ok(qWire, "wire to api.q should exist");
  });

  test("alias inside nested scope blocks parses correctly", () => {
    const instr = bridge`
      version 1.5

      bridge Query.user {
        with std.str.toUpperCase as uc
        with input as i
        with output as o

        o {
          .info {
            alias upper <- uc:i.name
            .displayName <- upper
            .email <- i.email
          }
        }
      }
    `;
    const parsed = parseBridge(instr);
    const br = parsed.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const pullWires = br.wires.filter((w) => w.sources[0]?.expr.type === "ref");
    // Alias creates a __local wire
    const localWire = pullWires.find(
      (w) => w.to.module === "__local" && w.to.field === "upper",
    );
    assert.ok(localWire, "alias wire to __local:Shadow:upper should exist");
    // displayName wire reads from alias
    const displayWire = pullWires.find(
      (w) => w.to.path.join(".") === "info.displayName",
    );
    assert.ok(displayWire, "wire to o.info.displayName should exist");
    const displayExpr = displayWire!.sources[0]!.expr;
    assert.equal(
      displayExpr.type === "ref" ? displayExpr.ref.module : undefined,
      "__local",
    );
    assert.equal(
      displayExpr.type === "ref" ? displayExpr.ref.field : undefined,
      "upper",
    );
    // email wire reads from input
    const emailWire = pullWires.find(
      (w) => w.to.path.join(".") === "info.email",
    );
    assert.ok(emailWire, "wire to o.info.email should exist");
  });
});

// ── Serializer round-trip tests ─────────────────────────────────────────────

describe("path scoping – serializer round-trip", () => {
  test("scoped wires round-trip through serializer as flat wires", () => {
    const input = bridge`
      version 1.5

      bridge Query.test {
        with input as i
        with output as o

        o.user {
          .name <- i.name
          .email <- i.email
        }
      }
    `;
    const parsed = parseBridge(input);
    const serialized = serializeBridge(parsed);
    const reparsed = parseBridge(serialized);

    const bridge1 = parsed.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const bridge2 = reparsed.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    assertDeepStrictEqualIgnoringLoc(bridge1.wires, bridge2.wires);
  });

  test("deeply nested scope round-trips correctly", () => {
    const input = bridge`
      version 1.5

      bridge Query.test {
        with input as i
        with output as o

        o.body.user {
          .profile {
            .id <- i.id
            .name <- i.name
          }
          .settings {
            .theme = "dark"
          }
        }
      }
    `;
    const parsed = parseBridge(input);
    const serialized = serializeBridge(parsed);
    const reparsed = parseBridge(serialized);

    const bridge1 = parsed.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const bridge2 = reparsed.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    assertDeepStrictEqualIgnoringLoc(bridge1.wires, bridge2.wires);
  });
});

// ── Array mapper path scoping tests ─────────────────────────────────────────

describe("path scoping – array mapper blocks", () => {
  test("scope block with constant inside array mapper produces element wire", () => {
    const result = parseBridge(bridge`
      version 1.5

      bridge Query.test {
        with input as i
        with output as o

        o <- i.items[] as item {
          .obj {
            .etc = 1
          }
        }
      }
    `);
    const instr = result.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const constWires = instr.wires.filter(
      (w) => w.sources[0]?.expr.type === "literal",
    );
    assert.equal(constWires.length, 1);
    const wire = constWires[0];
    assert.equal(
      wire.sources[0]!.expr.type === "literal"
        ? wire.sources[0]!.expr.value
        : undefined,
      "1",
    );
    assertDeepStrictEqualIgnoringLoc(wire.to.path, ["obj", "etc"]);
    assert.equal(wire.to.element, true);
  });

  test("scope block with pull wire inside array mapper references iterator", () => {
    const result = parseBridge(bridge`
      version 1.5

      bridge Query.test {
        with input as i
        with output as o

        o <- i.items[] as item {
          .obj {
            .name <- item.title
          }
        }
      }
    `);
    const instr = result.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const pullWires = instr.wires.filter(
      (w) => w.sources[0]?.expr.type === "ref",
    );
    const nameWire = pullWires.find((w) => w.to.path.join(".") === "obj.name");
    assert.ok(nameWire, "wire to obj.name should exist");
    const nameExpr = nameWire!.sources[0]!.expr;
    assert.equal(
      nameExpr.type === "ref" ? nameExpr.ref.element : undefined,
      true,
    );
    assertDeepStrictEqualIgnoringLoc(
      nameExpr.type === "ref" ? nameExpr.ref.path : undefined,
      ["title"],
    );
  });

  test("nested scope blocks inside array mapper flatten to correct paths", () => {
    const result = parseBridge(bridge`
      version 1.5

      bridge Query.test {
        with input as i
        with output as o

        o <- i.items[] as item {
          .a {
            .b {
              .c = "deep"
            }
          }
        }
      }
    `);
    const instr = result.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const constWires = instr.wires.filter(
      (w) => w.sources[0]?.expr.type === "literal",
    );
    assert.equal(constWires.length, 1);
    assertDeepStrictEqualIgnoringLoc(constWires[0].to.path, ["a", "b", "c"]);
    assert.equal(constWires[0].to.element, true);
  });

  test("array mapper scope block and flat element lines coexist", () => {
    const result = parseBridge(bridge`
      version 1.5

      bridge Query.test {
        with input as i
        with output as o

        o <- i.items[] as item {
          .flat <- item.id
          .nested {
            .x = 1
            .y <- item.val
          }
        }
      }
    `);
    const instr = result.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const constWires = instr.wires.filter(
      (w) => w.sources[0]?.expr.type === "literal",
    );
    const pullWires = instr.wires.filter(
      (w) => w.sources[0]?.expr.type === "ref",
    );
    assert.ok(
      constWires.find((w) => w.to.path.join(".") === "nested.x"),
      "nested.x constant should exist",
    );
    assert.ok(
      pullWires.find((w) => w.to.path.join(".") === "flat"),
      "flat pull wire should exist",
    );
    assert.ok(
      pullWires.find((w) => w.to.path.join(".") === "nested.y"),
      "nested.y pull wire should exist",
    );
  });
});

// ── Spread in scope blocks ───────────────────────────────────────────────────

describe("path scoping – spread syntax parser", () => {
  test("spread in top-level scope block produces root pull wire", () => {
    const result = parseBridge(bridge`
      version 1.5

      bridge Query.test {
        with input as i
        with myTool as t
        with output as o

        t {
          ... <- i
        }

        o.result <- t
      }
    `);
    const instr = result.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const pullWires = instr.wires.filter(
      (w) => w.sources[0]?.expr.type === "ref",
    );
    const spreadWire = pullWires.find((w) => w.to.path.length === 0);
    assert.ok(spreadWire, "spread wire targeting tool root should exist");
    assertDeepStrictEqualIgnoringLoc(
      spreadWire.sources[0]!.expr.type === "ref"
        ? spreadWire.sources[0]!.expr.ref.path
        : undefined,
      [],
    );
  });

  test("spread combined with constant wires in scope block", () => {
    const result = parseBridge(bridge`
      version 1.5

      bridge Query.test {
        with input as i
        with myTool as t
        with output as o

        t {
          ... <- i
          .extra = "added"
        }

        o.result <- t
      }
    `);
    const instr = result.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const pullWires = instr.wires.filter(
      (w) => w.sources[0]?.expr.type === "ref",
    );
    const constWires = instr.wires.filter(
      (w) => w.sources[0]?.expr.type === "literal",
    );
    assert.ok(
      pullWires.find((w) => w.to.path.length === 0),
      "spread wire to tool root should exist",
    );
    assert.ok(
      constWires.find((w) => w.to.path.join(".") === "extra"),
      "constant wire for .extra should exist",
    );
  });

  test("spread with sub-path source in scope block", () => {
    const result = parseBridge(bridge`
      version 1.5

      bridge Query.test {
        with input as i
        with myTool as t
        with output as o

        t {
          ... <- i.profile
        }

        o.result <- t
      }
    `);
    const instr = result.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const pullWires = instr.wires.filter(
      (w) => w.sources[0]?.expr.type === "ref",
    );
    const spreadWire = pullWires.find((w) => w.to.path.length === 0);
    assert.ok(spreadWire, "spread wire should exist");
    assertDeepStrictEqualIgnoringLoc(
      spreadWire.sources[0]!.expr.type === "ref"
        ? spreadWire.sources[0]!.expr.ref.path
        : undefined,
      ["profile"],
    );
  });

  test("spread in nested scope block produces wire to nested path", () => {
    const result = parseBridge(bridge`
      version 1.5

      bridge Query.test {
        with input as i
        with output as o

        o.wrapper {
          ... <- i
          .flag = "true"
        }
      }
    `);
    const instr = result.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const pullWires = instr.wires.filter(
      (w) => w.sources[0]?.expr.type === "ref",
    );
    const spreadWire = pullWires.find(
      (w) =>
        w.to.path.join(".") === "wrapper" &&
        (w.sources[0]!.expr.type === "ref"
          ? w.sources[0]!.expr.ref.path.length === 0
          : false),
    );
    assert.ok(spreadWire, "spread wire to o.wrapper should exist");
  });

  test("spread in deeply nested scope block", () => {
    const result = parseBridge(bridge`
      version 1.5

      bridge Query.test {
        with input as i
        with myTool as t
        with output as o

        t.nested {
          ... <- i
        }

        o.result <- t
      }
    `);
    const instr = result.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const pullWires = instr.wires.filter(
      (w) => w.sources[0]?.expr.type === "ref",
    );
    const spreadWire = pullWires.find((w) => w.to.path.join(".") === "nested");
    assert.ok(spreadWire, "spread wire to tool.nested should exist");
    assertDeepStrictEqualIgnoringLoc(
      spreadWire.sources[0]!.expr.type === "ref"
        ? spreadWire.sources[0]!.expr.ref.path
        : undefined,
      [],
    );
  });
});
