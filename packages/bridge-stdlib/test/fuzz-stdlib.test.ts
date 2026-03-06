import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { filter, find, first, toArray } from "../src/tools/arrays.ts";
import {
  toLowerCase,
  toUpperCase,
  trim,
  length,
} from "../src/tools/strings.ts";

// ── Chaotic value arbitrary ─────────────────────────────────────────────────
// Exercises every type boundary the stdlib tools might encounter.

const chaosValueArb: fc.Arbitrary<any> = fc.oneof(
  fc.string({ maxLength: 64 }),
  fc.integer(),
  fc.double({ noNaN: false }),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined),
  fc.constant(""),
  fc.constant(0),
  fc.constant(-0),
  fc.constant(Infinity),
  fc.constant(-Infinity),
  fc.array(fc.jsonValue(), { maxLength: 5 }),
  fc.dictionary(fc.string({ maxLength: 8 }), fc.jsonValue(), { maxKeys: 4 }),
);

// ── Array tool fuzzing ──────────────────────────────────────────────────────

describe("stdlib fuzz — array tools", () => {
  test("filter never throws on any input type", { timeout: 30_000 }, () => {
    fc.assert(
      fc.property(chaosValueArb, (value) => {
        // Must not throw — returns undefined for non-arrays
        const result = filter({ in: value, key: "x" });
        if (!Array.isArray(value)) {
          assert.equal(result, undefined);
        }
      }),
      { numRuns: 2_000 },
    );
  });

  test("find never throws on any input type", { timeout: 30_000 }, () => {
    fc.assert(
      fc.property(chaosValueArb, (value) => {
        const result = find({ in: value, key: "x" });
        if (!Array.isArray(value)) {
          assert.equal(result, undefined);
        }
      }),
      { numRuns: 2_000 },
    );
  });

  test(
    "filter produces correct results on valid array input with chaotic criteria",
    { timeout: 30_000 },
    () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.dictionary(fc.string({ maxLength: 8 }), fc.jsonValue(), {
              maxKeys: 4,
            }),
            { maxLength: 10 },
          ),
          fc.string({ maxLength: 8 }).filter((k) => k !== "in"),
          fc.jsonValue(),
          (arr, key, value) => {
            const result = filter({ in: arr, [key]: value });
            assert.ok(Array.isArray(result));
            // Every element in the result must match the criterion
            for (const item of result) {
              assert.equal(item[key], value);
            }
          },
        ),
        { numRuns: 2_000 },
      );
    },
  );

  test(
    "first never throws on any input type (non-strict mode)",
    { timeout: 30_000 },
    () => {
      fc.assert(
        fc.property(chaosValueArb, (value) => {
          // Non-strict mode must not throw
          const result = first({ in: value });
          if (!Array.isArray(value)) {
            assert.equal(result, undefined);
          }
        }),
        { numRuns: 2_000 },
      );
    },
  );

  test("toArray never throws on any input type", { timeout: 30_000 }, () => {
    fc.assert(
      fc.property(chaosValueArb, (value) => {
        const result = toArray({ in: value });
        assert.ok(Array.isArray(result));
      }),
      { numRuns: 2_000 },
    );
  });
});

// ── String tool fuzzing ─────────────────────────────────────────────────────

describe("stdlib fuzz — string tools", () => {
  test(
    "toLowerCase never throws on any input type",
    { timeout: 30_000 },
    () => {
      fc.assert(
        fc.property(chaosValueArb, (value) => {
          // Must not throw — returns undefined for non-strings via optional chaining
          const result = toLowerCase({ in: value });
          if (typeof value === "string") {
            assert.equal(result, value.toLowerCase());
          }
        }),
        { numRuns: 2_000 },
      );
    },
  );

  test(
    "toUpperCase never throws on any input type",
    { timeout: 30_000 },
    () => {
      fc.assert(
        fc.property(chaosValueArb, (value) => {
          const result = toUpperCase({ in: value });
          if (typeof value === "string") {
            assert.equal(result, value.toUpperCase());
          }
        }),
        { numRuns: 2_000 },
      );
    },
  );

  test("trim never throws on any input type", { timeout: 30_000 }, () => {
    fc.assert(
      fc.property(chaosValueArb, (value) => {
        const result = trim({ in: value });
        if (typeof value === "string") {
          assert.equal(result, value.trim());
        }
      }),
      { numRuns: 2_000 },
    );
  });

  test("length never throws on any input type", { timeout: 30_000 }, () => {
    fc.assert(
      fc.property(chaosValueArb, (value) => {
        const result = length({ in: value });
        if (typeof value === "string") {
          assert.equal(result, value.length);
        }
      }),
      { numRuns: 2_000 },
    );
  });
});
