import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  parseBridgeFormat as parseBridge,
  serializeBridge,
} from "@stackables/bridge-parser";
import type { Bridge } from "@stackables/bridge-core";
import { SELF_MODULE } from "@stackables/bridge-core";
import { assertDeepStrictEqualIgnoringLoc } from "./utils/parse-test-utils.ts";
import { bridge } from "@stackables/bridge-core";

// ── Parser: `force <handle>` creates forces entries ─────────────────────────

describe("parseBridge: force <handle>", () => {
  test("regular bridge has no forces", () => {
    const instr = parseBridge(bridge`
      version 1.5

      bridge Query.demo {
        with myTool as t
        with input as i
        with output as o

      t.action <- i.name
      o.result <- t.output

      }
    `).instructions.find((i): i is Bridge => i.kind === "bridge")!;

    assert.equal(instr.forces, undefined);
  });

  test("force statement creates a forces entry", () => {
    const instr = parseBridge(bridge`
      version 1.5

      bridge Mutation.audit {
        with logger.log as lg
        with input as i

      lg.action <- i.event
      force lg

      }
    `).instructions.find((i): i is Bridge => i.kind === "bridge")!;

    assert.ok(instr.forces, "should have forces");
    assert.equal(instr.forces!.length, 1);
    assert.equal(instr.forces![0].handle, "lg");
    assert.equal(instr.forces![0].module, "logger");
    assert.equal(instr.forces![0].field, "log");
    assert.equal(instr.forces![0].instance, 1);
  });

  test("force and regular wires coexist", () => {
    const instr = parseBridge(bridge`
      version 1.5

      bridge Query.demo {
        with mainApi as m
        with audit.log as audit
        with input as i
        with output as o

      m.q <- i.query
      audit.action <- i.query
      force audit
      o.result <- m.data

      }
    `).instructions.find((i): i is Bridge => i.kind === "bridge")!;

    assert.ok(instr.forces);
    assert.equal(instr.forces!.length, 1);
    assert.equal(instr.forces![0].handle, "audit");
    for (const w of instr.wires) {
      if ("from" in w) {
        assert.equal(
          (w as any).force,
          undefined,
          "wires should not have force",
        );
      }
    }
  });

  test("multiple force statements", () => {
    const instr = parseBridge(bridge`
      version 1.5

      bridge Mutation.multi {
        with logger.log as lg
        with metrics.emit as mt
        with input as i

      lg.action <- i.event
      mt.name <- i.event
      force lg
      force mt

      }
    `).instructions.find((i): i is Bridge => i.kind === "bridge")!;

    assert.ok(instr.forces);
    assert.equal(instr.forces!.length, 2);
    assert.equal(instr.forces![0].handle, "lg");
    assert.equal(instr.forces![1].handle, "mt");
  });

  test("force on undeclared handle throws", () => {
    assert.throws(
      () =>
        parseBridge(bridge`
          version 1.5

          bridge Query.demo {
            with input as i
            with output as o

          force unknown

          }
        `),
      /Cannot force undeclared handle "unknown"/,
    );
  });

  test("force on simple (non-dotted) tool handle", () => {
    const instr = parseBridge(bridge`
      version 1.5

      bridge Query.demo {
        with myTool as t
        with input as i
        with output as o

      t.in <- i.name
      force t
      o.result <- t.out

      }
    `).instructions.find((i): i is Bridge => i.kind === "bridge")!;

    assert.ok(instr.forces);
    assert.equal(instr.forces!.length, 1);
    assert.equal(instr.forces![0].handle, "t");
    assert.equal(instr.forces![0].module, SELF_MODULE);
    assert.equal(instr.forces![0].type, "Tools");
    assert.equal(instr.forces![0].field, "myTool");
  });

  test("force without any wires to the handle", () => {
    const instr = parseBridge(bridge`
      version 1.5

      bridge Mutation.fire {
        with sideEffect as se
        with input as i
        with output as o

      se.action = "fire"
      force se
      o.ok = "true"

      }
    `).instructions.find((i): i is Bridge => i.kind === "bridge")!;

    assert.ok(instr.forces);
    assert.equal(instr.forces![0].handle, "se");
    assert.equal(
      instr.forces![0].catchError,
      undefined,
      "default is critical",
    );
  });

  test("force catch null sets catchError flag", () => {
    const instr = parseBridge(bridge`
      version 1.5

      bridge Mutation.fire {
        with analytics as ping
        with input as i
        with output as o

      ping.event <- i.event
      force ping catch null
      o.ok = "true"

      }
    `).instructions.find((i): i is Bridge => i.kind === "bridge")!;

    assert.ok(instr.forces);
    assert.equal(instr.forces!.length, 1);
    assert.equal(instr.forces![0].handle, "ping");
    assert.equal(instr.forces![0].catchError, true);
  });

  test("mixed critical and fire-and-forget forces", () => {
    const instr = parseBridge(bridge`
      version 1.5

      bridge Mutation.multi {
        with logger.log as lg
        with metrics.emit as mt
        with input as i

      lg.action <- i.event
      mt.name <- i.event
      force lg
      force mt catch null

      }
    `).instructions.find((i): i is Bridge => i.kind === "bridge")!;

    assert.ok(instr.forces);
    assert.equal(instr.forces!.length, 2);
    assert.equal(instr.forces![0].handle, "lg");
    assert.equal(instr.forces![0].catchError, undefined, "lg is critical");
    assert.equal(instr.forces![1].handle, "mt");
    assert.equal(instr.forces![1].catchError, true, "mt is fire-and-forget");
  });
});

// ── Serializer roundtrip ─────────────────────────────────────────────────────

describe("serializeBridge: force statement roundtrip", () => {
  test("force statement roundtrips", () => {
    const input = bridge`
      version 1.5
      bridge Mutation.audit {
        with logger.log as lg
        with input as i

      lg.action <- i.event
      lg.userId <- i.userId
      force lg

      }
    `;
    const instructions = parseBridge(input);
    const serialized = serializeBridge(instructions);
    const reparsed = parseBridge(serialized);
    assertDeepStrictEqualIgnoringLoc(reparsed, instructions);
  });

  test("mixed force and regular wires roundtrip", () => {
    const input = bridge`
      version 1.5
      bridge Query.demo {
        with mainApi as m
        with audit.log as audit
        with input as i
        with output as o

      m.q <- i.query
      audit.action <- i.query
      force audit
      o.result <- m.data

      }
    `;
    const instructions = parseBridge(input);
    const serialized = serializeBridge(instructions);
    const reparsed = parseBridge(serialized);
    assertDeepStrictEqualIgnoringLoc(reparsed, instructions);
  });

  test("serialized output contains force syntax", () => {
    const input = bridge`
      version 1.5
      bridge Mutation.audit {
        with logger.log as lg
        with input as i

      lg.action <- i.event
      force lg

      }
    `;
    const output = serializeBridge(parseBridge(input));
    assert.ok(
      output.includes("force lg"),
      "serialized output should contain 'force lg'",
    );
    assert.ok(
      !output.includes("<-!"),
      "serialized output should NOT contain <-!",
    );
  });

  test("force catch null roundtrips", () => {
    const input = bridge`
      version 1.5
      bridge Mutation.audit {
        with analytics as ping
        with input as i

      ping.event <- i.event
      force ping catch null

      }
    `;
    const instructions = parseBridge(input);
    const serialized = serializeBridge(instructions);
    assert.ok(
      serialized.includes("force ping catch null"),
      "should contain catch null",
    );
    const reparsed = parseBridge(serialized);
    assertDeepStrictEqualIgnoringLoc(reparsed, instructions);
  });

  test("mixed critical and fire-and-forget roundtrip", () => {
    const input = bridge`
      version 1.5
      bridge Mutation.multi {
        with logger.log as lg
        with metrics.emit as mt
        with input as i

      lg.action <- i.event
      mt.name <- i.event
      force lg
      force mt catch null

      }
    `;
    const instructions = parseBridge(input);
    const serialized = serializeBridge(instructions);
    const reparsed = parseBridge(serialized);
    assertDeepStrictEqualIgnoringLoc(reparsed, instructions);
  });

  test("multiple force statements roundtrip", () => {
    const input = bridge`
      version 1.5
      bridge Mutation.multi {
        with logger.log as lg
        with metrics.emit as mt
        with input as i

      lg.action <- i.event
      mt.name <- i.event
      force lg
      force mt

      }
    `;
    const instructions = parseBridge(input);
    const serialized = serializeBridge(instructions);
    const reparsed = parseBridge(serialized);
    assertDeepStrictEqualIgnoringLoc(reparsed, instructions);
  });
});
