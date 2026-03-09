/**
 * Unit tests for the standard library tools (std namespace).
 *
 * These test individual tool functions directly — no gateway or bridge engine.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { std } from "../src/index.ts";
import { audit } from "../src/tools/audit.ts";

// ── String tools ────────────────────────────────────────────────────────────

describe("upperCase tool", () => {
  test("converts string to uppercase", () => {
    assert.equal(std.str.toUpperCase({ in: "hello" }), "HELLO");
  });

  test("handles empty string", () => {
    assert.equal(std.str.toUpperCase({ in: "" }), "");
  });

  test("handles already uppercase", () => {
    assert.equal(std.str.toUpperCase({ in: "HELLO" }), "HELLO");
  });

  test("handles mixed case with numbers", () => {
    assert.equal(std.str.toUpperCase({ in: "abc123def" }), "ABC123DEF");
  });
});

describe("lowerCase tool", () => {
  test("converts string to lowercase", () => {
    assert.equal(std.str.toLowerCase({ in: "HELLO" }), "hello");
  });

  test("handles empty string", () => {
    assert.equal(std.str.toLowerCase({ in: "" }), "");
  });

  test("handles already lowercase", () => {
    assert.equal(std.str.toLowerCase({ in: "hello" }), "hello");
  });

  test("handles mixed case with symbols", () => {
    assert.equal(
      std.str.toLowerCase({ in: "Hello-World_123" }),
      "hello-world_123",
    );
  });
});

describe("trim tool", () => {
  test("removes leading and trailing whitespace", () => {
    assert.equal(std.str.trim({ in: "  hello  " }), "hello");
  });

  test("handles empty string", () => {
    assert.equal(std.str.trim({ in: "" }), "");
  });

  test("handles string with no whitespace", () => {
    assert.equal(std.str.trim({ in: "hello" }), "hello");
  });

  test("handles tabs and newlines", () => {
    assert.equal(std.str.trim({ in: "\t hello\n " }), "hello");
  });
});

describe("length tool", () => {
  test("returns string length", () => {
    assert.equal(std.str.length({ in: "hello" }), 5);
  });

  test("returns 0 for empty string", () => {
    assert.equal(std.str.length({ in: "" }), 0);
  });

  test("counts spaces", () => {
    assert.equal(std.str.length({ in: "a b c" }), 5);
  });
});

// ── Array tools ─────────────────────────────────────────────────────────────

describe("filter tool", () => {
  const data = [
    { id: 1, name: "Alice", role: "admin" },
    { id: 2, name: "Bob", role: "user" },
    { id: 3, name: "Charlie", role: "user" },
  ];

  test("filters by single criterion", () => {
    const result = std.arr.filter({ in: data, role: "user" });
    assert.deepEqual(result, [
      { id: 2, name: "Bob", role: "user" },
      { id: 3, name: "Charlie", role: "user" },
    ]);
  });

  test("filters by multiple criteria", () => {
    const result = std.arr.filter({ in: data, role: "user", name: "Charlie" });
    assert.deepEqual(result, [{ id: 3, name: "Charlie", role: "user" }]);
  });

  test("returns empty array when no match", () => {
    const result = std.arr.filter({ in: data, name: "Dave" });
    assert.deepEqual(result, []);
  });

  test("returns all items when criteria match all", () => {
    const allUsers = [
      { id: 1, active: true },
      { id: 2, active: true },
    ];
    const result = std.arr.filter({ in: allUsers, active: true });
    assert.deepEqual(result, allUsers);
  });

  test("handles empty array", () => {
    const result = std.arr.filter({ in: [], role: "admin" });
    assert.deepEqual(result, []);
  });
});

describe("findObject tool", () => {
  const data = [
    { id: 1, name: "Alice", role: "admin" },
    { id: 2, name: "Bob", role: "user" },
    { id: 3, name: "Charlie", role: "user" },
  ];

  test("finds by single criterion", () => {
    const result = std.arr.find({ in: data, name: "Bob" });
    assert.deepEqual(result, { id: 2, name: "Bob", role: "user" });
  });

  test("finds by multiple criteria", () => {
    const result = std.arr.find({ in: data, role: "user", name: "Charlie" });
    assert.deepEqual(result, { id: 3, name: "Charlie", role: "user" });
  });

  test("returns undefined when no match", () => {
    const result = std.arr.find({ in: data, name: "Dave" });
    assert.equal(result, undefined);
  });

  test("returns first match when multiple match", () => {
    const result = std.arr.find({ in: data, role: "user" });
    assert.deepEqual(result, { id: 2, name: "Bob", role: "user" });
  });

  test("handles empty array", () => {
    const result = std.arr.find({ in: [], name: "Alice" });
    assert.equal(result, undefined);
  });
});

describe("pickFirst tool", () => {
  test("returns first element", () => {
    assert.equal(std.arr.first({ in: [10, 20, 30] }), 10);
  });

  test("returns undefined for empty array", () => {
    assert.equal(std.arr.first({ in: [] }), undefined);
  });

  test("returns single element", () => {
    assert.deepEqual(std.arr.first({ in: [{ id: 1 }] }), { id: 1 });
  });

  test("strict mode: passes with exactly one element", () => {
    assert.equal(std.arr.first({ in: [42], strict: true }), 42);
  });

  test("strict mode: throws on empty array", () => {
    assert.throws(() => std.arr.first({ in: [], strict: true }), /non-empty/);
  });

  test("strict mode: throws on multiple elements", () => {
    assert.throws(
      () => std.arr.first({ in: [1, 2], strict: true }),
      /exactly one/,
    );
  });

  test("strict as string 'true' works", () => {
    assert.equal(std.arr.first({ in: [7], strict: "true" }), 7);
  });
});

describe("toArray tool", () => {
  test("wraps single value in array", () => {
    assert.deepEqual(std.arr.toArray({ in: 42 }), [42]);
  });

  test("wraps object in array", () => {
    assert.deepEqual(std.arr.toArray({ in: { a: 1 } }), [{ a: 1 }]);
  });

  test("wraps string in array", () => {
    assert.deepEqual(std.arr.toArray({ in: "hello" }), ["hello"]);
  });

  test("returns array as-is if already array", () => {
    assert.deepEqual(std.arr.toArray({ in: [1, 2, 3] }), [1, 2, 3]);
  });

  test("wraps null in array", () => {
    assert.deepEqual(std.arr.toArray({ in: null }), [null]);
  });
});

// ── std bundle ──────────────────────────────────────────────────────────────

describe("std bundle", () => {
  test("std namespace contains transform tools", () => {
    assert.ok(std.audit, "audit present");
    assert.ok(std.httpCall, "httpCall present");
    assert.ok(std.httpCallSSE, "httpCallSSE present");
    assert.ok(std.accumulate, "accumulate present");
    assert.ok(std.str.toUpperCase, "upperCase present");
    assert.ok(std.str.toLowerCase, "lowerCase present");
    assert.ok(std.arr.find, "findObject present");
    assert.ok(std.arr.first, "pickFirst present");
    assert.ok(std.arr.toArray, "toArray present");
    assert.equal(Object.keys(std).length, 6);
  });

  test("httpCall is callable with std. prefix", () => {
    assert.equal(typeof std.httpCall, "function");
  });
});

// ── audit tool ──────────────────────────────────────────────────────────────

describe("audit tool", () => {
  test("uses ToolContext logger when provided", () => {
    const logged: any[] = [];
    const logger = { info: (...args: any[]) => logged.push(args) };

    const input = { action: "login", userId: "u42" };
    const result = audit(input, { logger });

    assert.deepEqual(
      result,
      input,
      "returns input as-is (including level default)",
    );
    assert.equal(logged.length, 1, "logged exactly once");
    // structured: data first, message last
    assert.deepEqual(logged[0][0], { action: "login", userId: "u42" });
    assert.equal(logged[0][1], "[bridge:audit]");
  });

  test("no-op when no ToolContext logger", () => {
    assert.equal(typeof audit, "function");
    // No logger → noop, should not throw
    assert.deepEqual(audit({ x: 1 }), { x: 1 });
  });

  test("level input selects logger method", () => {
    const warns: any[] = [];
    const infos: any[] = [];
    const logger = {
      info: (...a: any[]) => infos.push(a),
      warn: (...a: any[]) => warns.push(a),
    };

    audit({ action: "risky", level: "warn" }, { logger });

    assert.equal(infos.length, 0, "info not called");
    assert.equal(warns.length, 1, "warn called");
    assert.deepEqual(warns[0][0], { action: "risky" });
    assert.equal(warns[0][1], "[bridge:audit]");
  });

  test("ToolContext logger receives all wired inputs", () => {
    const entries: any[] = [];
    const logger = { info: (...a: any[]) => entries.push(a) };

    audit(
      { action: "order", userId: "u1", amount: 99.5, item: "widget" },
      { logger },
    );

    assert.equal(entries.length, 1);
    const payload = entries[0][0];
    assert.equal(payload.action, "order");
    assert.equal(payload.userId, "u1");
    assert.equal(payload.amount, 99.5);
    assert.equal(payload.item, "widget");
  });
});
