import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBridgeFormat as parseBridge } from "../src/index.ts";
import type { ToolDef } from "../src/index.ts";
import { SELF_MODULE } from "../src/index.ts";
import { assertDeepStrictEqualIgnoringLoc } from "./parse-test-utils.ts";

/** Shorthand to make a NodeRef for Tools */
function toolRef(
  field: string,
  path: string[],
  extra?: { instance?: number },
): {
  module: string;
  type: string;
  field: string;
  path: string[];
  instance?: number;
} {
  return {
    module: SELF_MODULE,
    type: "Tools",
    field,
    path,
    ...(extra?.instance != null ? { instance: extra.instance } : {}),
  };
}

function constRef(path: string[]): {
  module: string;
  type: string;
  field: string;
  path: string[];
} {
  return { module: SELF_MODULE, type: "Const", field: "const", path };
}

function contextRef(path: string[]): {
  module: string;
  type: string;
  field: string;
  path: string[];
} {
  return { module: SELF_MODULE, type: "Context", field: "context", path };
}

function parseTool(text: string): ToolDef {
  const doc = parseBridge(text);
  const tools = doc.instructions.filter((i): i is ToolDef => i.kind === "tool");
  assert.ok(tools.length > 0, "Expected at least one tool");
  return tools[tools.length - 1];
}

// ═══════════════════════════════════════════════════════════════════════════
//  Tool self-wire tests
// ═══════════════════════════════════════════════════════════════════════════

describe("tool self-wires: constant (=)", () => {
  test("constant string value", () => {
    const tool = parseTool(`version 1.5
tool api from httpCall {
  .baseUrl = "https://example.com"
}`);
    assertDeepStrictEqualIgnoringLoc(tool.wires[0], {
      value: "https://example.com",
      to: toolRef("api", ["baseUrl"]),
    });
  });

  test("constant bare value", () => {
    const tool = parseTool(`version 1.5
tool api from httpCall {
  .method = GET
}`);
    assertDeepStrictEqualIgnoringLoc(tool.wires[0], {
      value: "GET",
      to: toolRef("api", ["method"]),
    });
  });

  test("constant nested path", () => {
    const tool = parseTool(`version 1.5
tool api from httpCall {
  .headers.Content-Type = "application/json"
}`);
    assertDeepStrictEqualIgnoringLoc(tool.wires[0], {
      value: "application/json",
      to: toolRef("api", ["headers", "Content-Type"]),
    });
  });
});

describe("tool self-wires: simple pull (<-)", () => {
  test("pull from context handle", () => {
    const tool = parseTool(`version 1.5
tool api from httpCall {
  with context
  .headers.Authorization <- context.auth.token
}`);
    assertDeepStrictEqualIgnoringLoc(tool.wires[0], {
      from: contextRef(["auth", "token"]),
      to: toolRef("api", ["headers", "Authorization"]),
    });
  });

  test("pull from const handle", () => {
    const tool = parseTool(`version 1.5
const timeout = 5000
tool api from httpCall {
  with const
  .timeout <- const.timeout
}`);
    assertDeepStrictEqualIgnoringLoc(tool.wires[0], {
      from: constRef(["timeout"]),
      to: toolRef("api", ["timeout"]),
    });
  });

  test("pull from tool handle", () => {
    const tool = parseTool(`version 1.5
tool authService from httpCall {
  .baseUrl = "https://auth.example.com"
}
tool api from httpCall {
  with authService as auth
  .headers.Authorization <- auth.access_token
}`);
    assertDeepStrictEqualIgnoringLoc(tool.wires[0], {
      from: { ...toolRef("authService", ["access_token"]), instance: 1 },
      to: toolRef("api", ["headers", "Authorization"]),
    });
  });
});

describe('tool self-wires: plain string (<- "...")', () => {
  test("plain string without interpolation", () => {
    const tool = parseTool(`version 1.5
tool api from httpCall {
  .format <- "json"
}`);
    assertDeepStrictEqualIgnoringLoc(tool.wires[0], {
      value: "json",
      to: toolRef("api", ["format"]),
    });
  });
});

describe('tool self-wires: string interpolation (<- "...{ref}...")', () => {
  test("string interpolation with const ref", () => {
    const tool = parseTool(`version 1.5
const apiVer = "v2"
tool api from httpCall {
  with const
  .path <- "/api/{const.apiVer}/search"
}`);
    // Should produce a concat fork + pipeHandle, similar to bridge blocks
    const pathWire = tool.wires.find(
      (w) => "to" in w && w.to.path[0] === "path",
    )!;
    assert.ok(pathWire, "Expected a wire targeting .path");
    assert.ok("from" in pathWire, "Expected a pull wire, not constant");
    // The from ref should be the concat fork output
    assert.equal((pathWire as any).from.field, "concat");
    assert.ok(
      (pathWire as any).pipe,
      "Expected pipe flag on interpolation wire",
    );
  });

  test("string interpolation with context ref", () => {
    const tool = parseTool(`version 1.5
tool api from httpCall {
  with context
  .path <- "/users/{context.userId}/profile"
}`);
    const pathWire = tool.wires.find(
      (w) => "to" in w && w.to.path[0] === "path",
    )!;
    assert.ok(pathWire, "Expected a wire targeting .path");
    assert.ok("from" in pathWire, "Expected a pull wire, not constant");
    assert.equal((pathWire as any).from.field, "concat");
  });

  test("self-reference in interpolation is circular dependency error", () => {
    assert.throws(
      () =>
        parseBridge(`version 1.5
tool geo from httpCall {
  .q <- "Berlin{.query}"
}`),
      (err: Error) => {
        assert.ok(
          err.message.includes("circular dependency"),
          `Expected circular dependency error, got: ${err.message}`,
        );
        return true;
      },
    );
  });
});

describe("tool self-wires: expression chain (<- ref + expr)", () => {
  test("expression with + operator", () => {
    const tool = parseTool(`version 1.5
const one = 1
tool api from httpCall {
  with const
  .limit <- const.one + 1
}`);
    const limitWire = tool.wires.find(
      (w) => "to" in w && w.to.path[0] === "limit",
    )!;
    assert.ok(limitWire, "Expected a wire targeting .limit");
    assert.ok("from" in limitWire, "Expected a pull wire");
    // Expression chains produce a pipe fork (desugared to internal.add/compare/etc.)
    assert.ok((limitWire as any).pipe, "Expected pipe flag on expression wire");
  });

  test("expression with > operator", () => {
    const tool = parseTool(`version 1.5
const threshold = 10
tool api from httpCall {
  with const
  .verbose <- const.threshold > 5
}`);
    const wire = tool.wires.find(
      (w) => "to" in w && w.to.path[0] === "verbose",
    )!;
    assert.ok(wire, "Expected a wire targeting .verbose");
    assert.ok("from" in wire, "Expected a pull wire");
    assert.ok((wire as any).pipe, "Expected pipe flag on expression wire");
  });
});

describe("tool self-wires: ternary (<- cond ? then : else)", () => {
  test("ternary with literal branches", () => {
    const tool = parseTool(`version 1.5
const flag = true
tool api from httpCall {
  with const
  .method <- const.flag ? "POST" : "GET"
}`);
    const wire = tool.wires.find(
      (w) => "to" in w && w.to.path[0] === "method",
    )!;
    assert.ok(wire, "Expected a wire targeting .method");
    // Ternary wires have a `cond` field
    assert.ok("cond" in wire, "Expected a ternary wire with cond field");
    assert.equal((wire as any).thenValue, '"POST"');
    assert.equal((wire as any).elseValue, '"GET"');
  });

  test("ternary with ref branches", () => {
    const tool = parseTool(`version 1.5
const flag = true
const urlA = "https://a.example.com"
const urlB = "https://b.example.com"
tool api from httpCall {
  with const
  .baseUrl <- const.flag ? const.urlA : const.urlB
}`);
    const wire = tool.wires.find(
      (w) => "to" in w && w.to.path[0] === "baseUrl",
    )!;
    assert.ok(wire, "Expected a wire targeting .baseUrl");
    assert.ok("cond" in wire, "Expected a ternary wire with cond field");
    assert.ok("thenRef" in wire, "Expected thenRef for ref branch");
    assert.ok("elseRef" in wire, "Expected elseRef for ref branch");
  });
});

describe("tool self-wires: coalesce (<- ref ?? fallback)", () => {
  test("nullish coalesce with literal fallback", () => {
    const tool = parseTool(`version 1.5
tool api from httpCall {
  with context
  .timeout <- context.settings.timeout ?? "5000"
}`);
    const wire = tool.wires.find(
      (w) => "to" in w && w.to.path[0] === "timeout",
    )!;
    assert.ok(wire, "Expected a wire targeting .timeout");
    assert.ok("from" in wire, "Expected a pull wire");
    assert.ok("fallbacks" in wire, "Expected fallbacks for coalesce");
    assert.equal((wire as any).fallbacks.length, 1);
    assert.equal((wire as any).fallbacks[0].type, "nullish");
    assert.equal((wire as any).fallbacks[0].value, '"5000"');
  });

  test("falsy coalesce with literal fallback", () => {
    const tool = parseTool(`version 1.5
tool api from httpCall {
  with context
  .format <- context.settings.format || "json"
}`);
    const wire = tool.wires.find(
      (w) => "to" in w && w.to.path[0] === "format",
    )!;
    assert.ok(wire, "Expected a wire targeting .format");
    assert.ok("fallbacks" in wire, "Expected fallbacks for coalesce");
    assert.equal((wire as any).fallbacks[0].type, "falsy");
  });
});

describe("tool self-wires: catch fallback", () => {
  test("catch with literal fallback", () => {
    const tool = parseTool(`version 1.5
tool api from httpCall {
  with context
  .path <- context.settings.path catch "/default"
}`);
    const wire = tool.wires.find((w) => "to" in w && w.to.path[0] === "path")!;
    assert.ok(wire, "Expected a wire targeting .path");
    assert.ok("from" in wire, "Expected a pull wire");
    assert.equal((wire as any).catchFallback, '"/default"');
  });
});

describe("tool self-wires: not prefix", () => {
  test("not prefix on source", () => {
    const tool = parseTool(`version 1.5
const debug = true
tool api from httpCall {
  with const
  .silent <- not const.debug
}`);
    const wire = tool.wires.find(
      (w) => "to" in w && w.to.path[0] === "silent",
    )!;
    assert.ok(wire, "Expected a wire targeting .silent");
    assert.ok("from" in wire, "Expected a pull wire");
    // `not` produces a pipe fork through the negation tool
    assert.ok((wire as any).pipe, "Expected pipe flag on not wire");
  });
});

describe("tool self-wires: integration", () => {
  test("full tool with mixed self-wire types", () => {
    const tool = parseTool(`version 1.5
const one = 1
tool geo from std.httpCall {
  with const
  .baseUrl = "https://nominatim.openstreetmap.org"
  .path = "/search"
  .format = "json"
  .limit <- const.one + 1
}`);
    assert.equal(tool.name, "geo");
    assert.equal(tool.fn, "std.httpCall");
    // 3 constants + expression fork wires (input to fork + constant operand + pipe output)
    assert.ok(
      tool.wires.length >= 4,
      `Expected at least 4 wires, got ${tool.wires.length}: ${JSON.stringify(
        tool.wires.map((w) => ("value" in w ? w.value : "pull")),
        null,
        2,
      )}`,
    );

    // First 3 are constants
    assertDeepStrictEqualIgnoringLoc(tool.wires[0], {
      value: "https://nominatim.openstreetmap.org",
      to: toolRef("geo", ["baseUrl"]),
    });
    assertDeepStrictEqualIgnoringLoc(tool.wires[1], {
      value: "/search",
      to: toolRef("geo", ["path"]),
    });
    assertDeepStrictEqualIgnoringLoc(tool.wires[2], {
      value: "json",
      to: toolRef("geo", ["format"]),
    });

    // Expression wire targets .limit (with internal fork wires before it)
    const limitWire = tool.wires.find(
      (w) =>
        "to" in w &&
        (w as any).to.field === "geo" &&
        (w as any).to.path?.[0] === "limit",
    );
    assert.ok(limitWire, "Expected a wire targeting geo.limit");
    assert.ok("from" in limitWire!, "Expected limit wire to be a pull wire");
    assert.ok((limitWire as any).pipe, "Expected pipe flag on expression wire");
  });
});
