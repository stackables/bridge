/**
 * Tests for BridgeLanguageService — diagnostics, completions, and hover.
 *
 * Exercises getDiagnostics (unknown std refs, versioned handle warnings),
 * getCompletions (namespace prefix, context), and getHover (all instruction
 * kinds and handle kinds).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BridgeLanguageService } from "../src/index.ts";
import { bridge } from "@stackables/bridge-core";

// ── getDiagnostics ─────────────────────────────────────────────────────────

describe("BridgeLanguageService.getDiagnostics", () => {
  test("empty text returns empty diagnostics", () => {
    const svc = new BridgeLanguageService();
    svc.update("");
    assert.deepStrictEqual(svc.getDiagnostics(), []);
  });

  test("whitespace-only text returns empty diagnostics", () => {
    const svc = new BridgeLanguageService();
    svc.update("   \n  ");
    assert.deepStrictEqual(svc.getDiagnostics(), []);
  });

  test("valid bridge has no error diagnostics", () => {
    const svc = new BridgeLanguageService();
    svc.update(bridge`
      version 1.5

      bridge Query.getCity {
        with input as i
        with output as o

        o.name <- i.query
      }
    `);
    const errors = svc.getDiagnostics().filter((d) => d.severity === "error");
    assert.equal(errors.length, 0);
  });

  test("unknown std.* ref reports an error diagnostic", () => {
    const svc = new BridgeLanguageService();
    svc.update(bridge`
      bridge Query.test {
        with std.unknownToolXYZ as t
        with input as i
        with output as o
      }
    `);
    const diags = svc.getDiagnostics();
    const errors = diags.filter((d) => d.severity === "error");
    assert.ok(errors.length > 0, "expected an error for the unknown std ref");
    assert.ok(
      errors.some((d) => d.message.includes("std.unknownToolXYZ")),
      "error message should mention the bad ref",
    );
  });

  test("unknown std.* ref carries correct range", () => {
    const svc = new BridgeLanguageService();
    svc.update(bridge`
      bridge Query.test {
        with std.badTool as t
        with input as i
        with output as o
      }
    `);
    const diags = svc.getDiagnostics();
    const err = diags.find(
      (d) => d.severity === "error" && d.message.includes("std.badTool"),
    );
    assert.ok(err);
    // The error range should point to the line containing `std.badTool`
    assert.equal(err.range.start.line, 1);
  });

  test("std.* ref on a comment line is not reported", () => {
    const svc = new BridgeLanguageService();
    svc.update(bridge`
      bridge Query.test {
        with input as i
        with output as o
        # std.nonExistent is just a comment
        o.x <- i.x
      }
    `);
    const unknownErrors = svc
      .getDiagnostics()
      .filter(
        (d) => d.severity === "error" && d.message.includes("std.nonExistent"),
      );
    assert.equal(
      unknownErrors.length,
      0,
      "comment lines should not trigger the ref check",
    );
  });

  test("versioned std tool exceeding bundled version reports a warning", () => {
    const svc = new BridgeLanguageService();
    svc.update(bridge`
      version 1.5
      bridge Query.test {
        with std.httpCall@99.0 as http
        with input as i
        with output as o
      }
    `);
    const warnings = svc
      .getDiagnostics()
      .filter((d) => d.severity === "warning");
    assert.ok(
      warnings.length > 0,
      "expected a warning for the version exceeding bundled std",
    );
    assert.ok(
      warnings.some((d) => d.message.includes("99.0")),
      "warning should mention the requested version",
    );
  });

  test("versioned non-std tool does not produce a version warning", () => {
    const svc = new BridgeLanguageService();
    svc.update(bridge`
      bridge Query.test {
        with myApi@2.0 as api
        with input as i
        with output as o
      }
    `);
    const versionWarnings = svc
      .getDiagnostics()
      .filter(
        (d) =>
          d.severity === "warning" && d.message.includes("exceeds bundled"),
      );
    assert.equal(versionWarnings.length, 0);
  });

  test("update with empty text after content resets diagnostics", () => {
    const svc = new BridgeLanguageService();
    svc.update(bridge`
      bridge Query.test {
        with std.badRef as t
        with input as i
        with output as o
      }
    `);
    assert.ok(svc.getDiagnostics().length > 0);
    svc.update("   ");
    assert.deepStrictEqual(svc.getDiagnostics(), []);
  });
});

// ── getCompletions ─────────────────────────────────────────────────────────

describe("BridgeLanguageService.getCompletions", () => {
  test("after 'std.' returns top-level namespace segments", () => {
    const svc = new BridgeLanguageService();
    svc.update("  with std.");
    const completions = svc.getCompletions({ line: 0, character: 11 });
    assert.ok(completions.length > 0, "should return namespace segments");
    const labels = completions.map((c) => c.label);
    assert.ok(labels.includes("str"), "should include str");
    assert.ok(labels.includes("arr"), "should include arr");
    // Namespace nodes are returned as "variable" kind
    const strEntry = completions.find((c) => c.label === "str");
    assert.equal(strEntry?.kind, "variable");
    assert.ok(strEntry?.detail?.includes("std.str"));
  });

  test("after 'std.str.' returns leaf function completions", () => {
    const svc = new BridgeLanguageService();
    svc.update("  with std.str.");
    const completions = svc.getCompletions({ line: 0, character: 15 });
    assert.ok(completions.length > 0, "should return leaf completions");
    const labels = completions.map((c) => c.label);
    assert.ok(labels.includes("toLowerCase"), "should include toLowerCase");
    // Leaf functions are returned as "function" kind
    const fn = completions.find((c) => c.label === "toLowerCase");
    assert.equal(fn?.kind, "function");
  });

  test("after 'std.' only returns next segment, not full path", () => {
    const svc = new BridgeLanguageService();
    svc.update("std.");
    const completions = svc.getCompletions({ line: 0, character: 4 });
    // No completion should have a dot in the label (only next segment)
    assert.ok(completions.every((c) => !c.label.includes(".")));
  });

  test("after '  with ' returns all fully-qualified std tool names", () => {
    const svc = new BridgeLanguageService();
    svc.update("  with ");
    const completions = svc.getCompletions({ line: 0, character: 7 });
    assert.ok(
      completions.length > 0,
      "should suggest tool names after 'with '",
    );
    assert.ok(
      completions.some((c) => c.label.startsWith("std.")),
      "should include std.* tools",
    );
    assert.ok(
      completions.every((c) => c.kind === "function"),
      "all should be function kind",
    );
  });

  test("after 'extends ' returns all FQN tool names", () => {
    const svc = new BridgeLanguageService();
    svc.update("tool sub extends ");
    const completions = svc.getCompletions({ line: 0, character: 17 });
    assert.ok(completions.length > 0);
    assert.ok(completions.some((c) => c.label.startsWith("std.")));
  });

  test("after 'from ' returns all FQN tool names", () => {
    const svc = new BridgeLanguageService();
    svc.update("from ");
    const completions = svc.getCompletions({ line: 0, character: 5 });
    assert.ok(completions.length > 0);
    assert.ok(completions.some((c) => c.label.startsWith("std.")));
  });

  test("at arbitrary mid-word position returns empty", () => {
    const svc = new BridgeLanguageService();
    svc.update("bridge Query.test {");
    const completions = svc.getCompletions({ line: 0, character: 5 });
    assert.deepStrictEqual(completions, []);
  });

  test("out-of-range line returns empty", () => {
    const svc = new BridgeLanguageService();
    svc.update("bridge Query.test {");
    const completions = svc.getCompletions({ line: 99, character: 0 });
    assert.deepStrictEqual(completions, []);
  });
});

// ── getHover ──────────────────────────────────────────────────────────────

describe("BridgeLanguageService.getHover", () => {
  test("empty text returns null", () => {
    const svc = new BridgeLanguageService();
    svc.update("");
    assert.equal(svc.getHover({ line: 0, character: 0 }), null);
  });

  test("non-word character (< 2 chars) returns null", () => {
    const svc = new BridgeLanguageService();
    svc.update("bridge Query.test {");
    // '{' at char 18 → extracted word = "" → null
    assert.equal(svc.getHover({ line: 0, character: 18 }), null);
  });

  test("single-char word returns null", () => {
    const svc = new BridgeLanguageService();
    svc.update("bridge Query.test {");
    // 'Q' has 'uery' after it → word = "Query" (5 chars)
    // Let's hover on a truly isolated 1-char word inside an expression
    svc.update("  o.x <- i.y");
    // 'o' at char 2 → word "o" (1 char) → null
    assert.equal(svc.getHover({ line: 0, character: 2 }), null);
  });

  test("hover on bridge type name", () => {
    const svc = new BridgeLanguageService();
    svc.update(bridge`
      version 1.5
      bridge Query.getCity {
        with input as inp
        with output as out
      }
    `);
    // "version 1.5" at line 0; "bridge Query.getCity {" at line 1 — "Query" at char 7
    const hover = svc.getHover({ line: 1, character: 7 });
    assert.ok(hover !== null, "should return hover for bridge type");
    assert.ok(
      hover.content.includes("Query.getCity"),
      `unexpected content: ${hover.content}`,
    );
  });

  test("hover on bridge field name", () => {
    const svc = new BridgeLanguageService();
    svc.update(bridge`
      version 1.5
      bridge Query.getCity {
        with input as inp
        with output as out
      }
    `);
    // "version 1.5" at line 0; "bridge Query.getCity {" at line 1 — "getCity" at char 13
    const hover = svc.getHover({ line: 1, character: 13 });
    assert.ok(hover !== null, "should return hover for bridge field");
    assert.ok(hover.content.includes("Query.getCity"));
  });

  test("bridge hover reports handle and wire count", () => {
    const svc = new BridgeLanguageService();
    svc.update(bridge`
      version 1.5
      bridge Query.getCity {
        with input as inp
        with output as out
        out.name <- inp.query
      }
    `);
    const hover = svc.getHover({ line: 1, character: 7 }); // "Query" on line 1
    assert.ok(hover !== null);
    // Should mention handles and wires
    assert.ok(hover.content.includes("handle"), hover.content);
  });

  test("hover on tool handle (tool kind) in bridge", () => {
    const svc = new BridgeLanguageService();
    //                          0         1         2
    //                          012345678901234567890123456789
    // "  with hereapi.geocode as geo"
    //   char positions: hereapi=7..13, .geocode=14..21, " as "=22..25, geo=26..28
    svc.update(bridge`
      version 1.5
      bridge Query.getCity {
        with hereapi.geocode as geo
        with input as inp
        with output as out
      }
    `);
    const hover = svc.getHover({ line: 2, character: 26 }); // "geo" on line 2
    assert.ok(hover !== null, "should return hover for tool handle");
    assert.ok(hover.content.includes("geo"), hover.content);
    assert.ok(hover.content.includes("hereapi.geocode"), hover.content);
    assert.ok(hover.content.includes("Tool handle"), hover.content);
  });

  test("hover on versioned tool handle shows version in content", () => {
    const svc = new BridgeLanguageService();
    //                          0         1         2         3
    //                          0123456789012345678901234567890123456
    // "  with hereapi.geocode@2.1 as geo"
    //   "geo" at char 30
    svc.update(bridge`
      version 1.5
      bridge Query.getCity {
        with hereapi.geocode@2.1 as geo
        with input as inp
        with output as out
      }
    `);
    const hover = svc.getHover({ line: 2, character: 30 }); // "geo" on line 2
    assert.ok(hover !== null, "should return hover for versioned handle");
    assert.ok(hover.content.includes("geo"), hover.content);
    assert.ok(hover.content.includes("2.1"), hover.content);
  });

  test("hover on input handle", () => {
    const svc = new BridgeLanguageService();
    svc.update(bridge`
      version 1.5
      bridge Query.getCity {
        with input as inp
        with output as out
      }
    `);
    //                   0         1
    //                   0123456789012345678
    // "  with input as inp" — "inp" at char 16, now on line 2
    const hover = svc.getHover({ line: 2, character: 16 }); // "inp"
    assert.ok(hover !== null, "should return hover for input handle");
    assert.ok(hover.content.includes("inp"), hover.content);
    assert.ok(hover.content.includes("Input handle"), hover.content);
  });

  test("hover on output handle", () => {
    const svc = new BridgeLanguageService();
    svc.update(bridge`
      version 1.5
      bridge Query.getCity {
        with input as inp
        with output as out
      }
    `);
    //                    0         1
    //                    01234567890123456789
    // "  with output as out" — "out" at char 17, now on line 3
    const hover = svc.getHover({ line: 3, character: 17 }); // "out"
    assert.ok(hover !== null, "should return hover for output handle");
    assert.ok(hover.content.includes("out"), hover.content);
    assert.ok(hover.content.includes("Output handle"), hover.content);
  });

  test("hover on context handle in bridge", () => {
    const svc = new BridgeLanguageService();
    svc.update(bridge`
      version 1.5
      bridge Query.getCity {
        with context as ctx
        with input as inp
        with output as out
      }
    `);
    //                     0         1
    //                     012345678901234567890
    // "  with context as ctx" — "ctx" at char 18, now on line 2
    const hover = svc.getHover({ line: 2, character: 18 }); // "ctx"
    assert.ok(hover !== null, "should return hover for context handle");
    assert.ok(hover.content.includes("ctx"), hover.content);
    assert.ok(hover.content.includes("Context handle"), hover.content);
  });

  test("hover on const handle in bridge", () => {
    const svc = new BridgeLanguageService();
    svc.update(bridge`
      version 1.5
      const defaults = "x"
      bridge Query.getCity {
        with const as consts
        with input as inp
        with output as out
      }
    `);
    //                    0         1
    //                    01234567890123456789012
    // "  with const as consts" — "consts" at char 16, now on line 3
    const hover = svc.getHover({ line: 3, character: 16 }); // "consts"
    assert.ok(hover !== null, "should return hover for const handle");
    assert.ok(hover.content.includes("consts"), hover.content);
    assert.ok(hover.content.includes("Const handle"), hover.content);
  });

  test("hover on tool block name", () => {
    const svc = new BridgeLanguageService();
    svc.update(bridge`
      version 1.5
      tool myApi httpCall {
        with context as ctx
      }
    `);
    // "tool myApi httpCall {" at line 1 — "myApi" at char 5
    const hover = svc.getHover({ line: 1, character: 5 }); // "myApi"
    assert.ok(hover !== null, "should return hover for tool name");
    assert.ok(hover.content.includes("myApi"), hover.content);
    assert.ok(hover.content.includes("Tool"), hover.content);
  });

  test("hover on tool block function name", () => {
    const svc = new BridgeLanguageService();
    svc.update(bridge`
      version 1.5
      tool myApi httpCall {
        with context as ctx
      }
    `);
    // "tool myApi httpCall {" at line 1 — "httpCall" at char 11
    const hover = svc.getHover({ line: 1, character: 11 }); // "httpCall"
    assert.ok(hover !== null, "should return hover for tool fn name");
    assert.ok(hover.content.includes("httpCall"), hover.content);
  });

  test("hover on context dep in tool block", () => {
    const svc = new BridgeLanguageService();
    svc.update(bridge`
      version 1.5
      tool myApi httpCall {
        with context as ctx
      }
    `);
    // "  with context as ctx" on line 2 — "ctx" at char 18
    const hover = svc.getHover({ line: 2, character: 18 }); // "ctx"
    assert.ok(hover !== null, "should return hover for context dep");
    assert.ok(hover.content.includes("ctx"), hover.content);
    assert.ok(hover.content.includes("Context handle"), hover.content);
  });

  test("hover on tool dep (tool kind) in tool block", () => {
    const svc = new BridgeLanguageService();
    svc.update(bridge`
      version 1.5
      tool childApi httpCall {
        with parentApi as dep
      }
    `);
    //                   0         1         2
    //                   012345678901234567890123
    // "  with parentApi as dep" on line 2 — "dep" at char 20
    const hover = svc.getHover({ line: 2, character: 20 }); // "dep"
    assert.ok(hover !== null, "should return hover for tool-kind dep");
    assert.ok(hover.content.includes("dep"), hover.content);
    assert.ok(hover.content.includes("Tool handle"), hover.content);
  });

  test("hover on const dep in tool block", () => {
    const svc = new BridgeLanguageService();
    svc.update(bridge`
      version 1.5
      const defaults = "x"
      tool myApi httpCall {
        with const as cfg
      }
    `);
    //                   0         1
    //                   0123456789012345678
    // "  with const as cfg" on line 3 — "cfg" at char 16
    const hover = svc.getHover({ line: 3, character: 16 }); // "cfg"
    assert.ok(hover !== null, "should return hover for const dep");
    assert.ok(hover.content.includes("cfg"), hover.content);
    assert.ok(hover.content.includes("Const handle"), hover.content);
  });

  test("hover on const instruction name", () => {
    const svc = new BridgeLanguageService();
    svc.update(bridge`
      version 1.5
      const myTimeout = 30
    `);
    // "const myTimeout = 30" at line 1 — "myTimeout" at char 6
    const hover = svc.getHover({ line: 1, character: 6 }); // "myTimeout"
    assert.ok(hover !== null, "should return hover for const name");
    assert.ok(hover.content.includes("myTimeout"), hover.content);
    assert.ok(hover.content.includes("Const"), hover.content);
    assert.ok(hover.content.includes("30"), hover.content);
  });

  test("hover on define block name", () => {
    const svc = new BridgeLanguageService();
    svc.update(bridge`
      version 1.5
      define myShape {
        with input as inp
        with output as out
        out.x <- inp.y
      }
    `);
    // "define myShape {" at line 1 — "myShape" at char 7
    const hover = svc.getHover({ line: 1, character: 7 }); // "myShape"
    assert.ok(hover !== null, "should return hover for define name");
    assert.ok(hover.content.includes("myShape"), hover.content);
    assert.ok(hover.content.includes("Define"), hover.content);
  });

  test("hover on define block shows handle and wire counts", () => {
    const svc = new BridgeLanguageService();
    svc.update(bridge`
      version 1.5
      define myPipe {
        with input as inp
        with output as out
        out.x <- inp.y
      }
    `);
    const hover = svc.getHover({ line: 1, character: 7 }); // "myPipe" at line 1
    assert.ok(hover !== null);
    assert.ok(hover.content.includes("handle"), hover.content);
    assert.ok(hover.content.includes("wire"), hover.content);
  });

  test("hover on unrecognized word returns null", () => {
    const svc = new BridgeLanguageService();
    svc.update(bridge`
      bridge Query.getCity {
        with input as inp
        with output as out
        out.name <- inp.query
      }
    `);
    // "  out.name <- inp.query" — "query" at char 16
    // "query" is not a handle name, type, field, or anything semantic
    const hover = svc.getHover({ line: 3, character: 16 }); // "query"
    assert.equal(hover, null, "unrecognized word should return null");
  });

  test("hover on input handle with default name", () => {
    const svc = new BridgeLanguageService();
    svc.update(bridge`
      version 1.5
      bridge Query.getCity {
        with input
        with output as out
      }
    `);
    // "  with input" on line 2 — "input" at char 7
    const hover = svc.getHover({ line: 2, character: 7 }); // "input"
    assert.ok(hover !== null, "should hover on default input handle");
    assert.ok(hover.content.includes("Input handle"), hover.content);
  });

  test("hover on output handle with default name", () => {
    const svc = new BridgeLanguageService();
    svc.update(bridge`
      version 1.5
      bridge Query.getCity {
        with input as inp
        with output
      }
    `);
    // "  with output" on line 3 — "output" at char 7
    const hover = svc.getHover({ line: 3, character: 7 }); // "output"
    assert.ok(hover !== null, "should hover on default output handle");
    assert.ok(hover.content.includes("Output handle"), hover.content);
  });
});
