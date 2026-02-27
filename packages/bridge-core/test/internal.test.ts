/**
 * Unit tests for the `internal` tool primitives in bridge-core.
 * These functions are auto-injected by the ExecutionTree and never exposed
 * through the public API — they live here where they're defined.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  add,
  and,
  concat,
  divide,
  eq,
  gt,
  gte,
  lt,
  lte,
  multiply,
  neq,
  not,
  or,
  subtract,
} from "../src/tools/internal.ts";

// ── Math tools ───────────────────────────────────────────────────────────────

describe("math tools", () => {
  test("multiply", () => {
    assert.equal(multiply({ a: 3, b: 4 }), 12);
    assert.equal(multiply({ a: 9.99, b: 100 }), 999);
  });
  test("divide", () => {
    assert.equal(divide({ a: 10, b: 2 }), 5);
    assert.equal(divide({ a: 100, b: 3 }), 100 / 3);
  });
  test("add", () => {
    assert.equal(add({ a: 3, b: 4 }), 7);
    assert.equal(add({ a: -1, b: 1 }), 0);
  });
  test("subtract", () => {
    assert.equal(subtract({ a: 10, b: 3 }), 7);
  });
});

// ── Comparison tools ─────────────────────────────────────────────────────────

describe("comparison tools return boolean", () => {
  test("eq", () => {
    assert.equal(eq({ a: 1, b: 1 }), true);
    assert.equal(eq({ a: 1, b: 2 }), false);
    assert.equal(eq({ a: "x", b: "x" }), true);
    assert.equal(eq({ a: "x", b: "y" }), false);
  });
  test("neq", () => {
    assert.equal(neq({ a: 1, b: 2 }), true);
    assert.equal(neq({ a: 1, b: 1 }), false);
  });
  test("gt", () => {
    assert.equal(gt({ a: 5, b: 3 }), true);
    assert.equal(gt({ a: 3, b: 5 }), false);
    assert.equal(gt({ a: 3, b: 3 }), false);
  });
  test("gte", () => {
    assert.equal(gte({ a: 3, b: 3 }), true);
    assert.equal(gte({ a: 2, b: 3 }), false);
  });
  test("lt", () => {
    assert.equal(lt({ a: 2, b: 3 }), true);
    assert.equal(lt({ a: 3, b: 2 }), false);
  });
  test("lte", () => {
    assert.equal(lte({ a: 3, b: 3 }), true);
    assert.equal(lte({ a: 4, b: 3 }), false);
  });
});

// ── Non-number handling ───────────────────────────────────────────────────────

describe("expressions: non-number handling", () => {
  test("undefined input coerces to NaN via Number()", () => {
    // Number(undefined) = NaN, so undefined * 100 = NaN
    assert.ok(Number.isNaN(multiply({ a: undefined as any, b: 100 })));
    assert.ok(Number.isNaN(add({ a: undefined as any, b: 5 })));
  });

  test("null input coerces to 0 via Number()", () => {
    // Number(null) = 0
    assert.equal(multiply({ a: null as any, b: 100 }), 0);
    assert.equal(add({ a: null as any, b: 5 }), 5);
  });

  test("string number coerces correctly", () => {
    assert.equal(multiply({ a: "10" as any, b: "5" as any }), 50);
    assert.equal(add({ a: "3" as any, b: "4" as any }), 7);
  });

  test("non-numeric string produces NaN", () => {
    assert.ok(Number.isNaN(multiply({ a: "hello" as any, b: 100 })));
  });

  test("comparison with NaN returns false", () => {
    assert.equal(gt({ a: NaN, b: 5 }), false);
    assert.equal(eq({ a: NaN, b: NaN }), false);
  });
});

// ── Boolean logic tools ───────────────────────────────────────────────────────

describe("boolean logic tools", () => {
  test("and", () => {
    assert.equal(and({ a: true, b: true }), true);
    assert.equal(and({ a: true, b: false }), false);
    assert.equal(and({ a: false, b: true }), false);
    assert.equal(and({ a: 1, b: "yes" }), true);
    assert.equal(and({ a: 0, b: true }), false);
  });
  test("or", () => {
    assert.equal(or({ a: true, b: false }), true);
    assert.equal(or({ a: false, b: true }), true);
    assert.equal(or({ a: false, b: false }), false);
    assert.equal(or({ a: 0, b: "" }), false);
    assert.equal(or({ a: 0, b: 1 }), true);
  });
  test("not", () => {
    assert.equal(not({ a: true }), false);
    assert.equal(not({ a: false }), true);
    assert.equal(not({ a: 0 }), true);
    assert.equal(not({ a: 1 }), false);
    assert.equal(not({ a: "" }), true);
    assert.equal(not({ a: null }), true);
  });
});

// ── String concat tool ───────────────────────────────────────────────────────

describe("internal.concat tool", () => {
  test("joins string parts", () => {
    assert.deepEqual(concat({ parts: ["Hello", ", ", "World!"] }), {
      value: "Hello, World!",
    });
  });

  test("coerces numbers to strings", () => {
    assert.deepEqual(concat({ parts: ["Count: ", 42] }), {
      value: "Count: 42",
    });
  });

  test("coerces null and undefined to empty strings", () => {
    assert.deepEqual(concat({ parts: ["a", null, "b", undefined, "c"] }), {
      value: "abc",
    });
  });

  test("coerces booleans", () => {
    assert.deepEqual(concat({ parts: ["is: ", true] }), { value: "is: true" });
  });

  test("empty parts produces empty string", () => {
    assert.deepEqual(concat({ parts: [] }), { value: "" });
  });
});
