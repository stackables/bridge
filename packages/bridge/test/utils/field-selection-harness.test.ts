/**
 * Regression tests for the GraphQL field selection harness helpers.
 *
 * Documents the semantics of the `fields` option used in regression tests:
 *
 * - `field` or `field.subfield` — **full selector** (cascades to full
 *   sub-object).  Represented in GraphQL by replacing the output type
 *   with `JSONObject` so no sub-field selection is required in the query.
 *
 * - `field.*` or `field.subfield.*` — **shallow sub-select** of scalar
 *   values only.  Object-typed children are excluded from the query.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildGraphQLSchema,
  buildSelectionTreeFromPaths,
  buildGraphQLOperationSource,
  collectFieldsRequiringJSONObject,
  replaceFieldTypesWithJSONObject,
  type Scenario,
} from "./regression.ts";

// ── Shared test schema ──────────────────────────────────────────────────────
//
// Schema shape:
//   id: Int
//   legs:
//     a: String
//     b: Int
//     c:
//       c1: String
//       c2: Float

const testSDL = `
type Query {
  travel(id: Int): TravelResult
}

type TravelResult {
  id: Int
  legs: TravelLegs
}

type TravelLegs {
  a: String
  b: Int
  c: TravelLegsC
}

type TravelLegsC {
  c1: String
  c2: Float
}
`;

describe("field selection harness", () => {
  // ── buildSelectionTreeFromPaths ──────────────────────────────────────────

  describe("buildSelectionTreeFromPaths", () => {
    test("scalar path produces empty leaf", () => {
      const tree = buildSelectionTreeFromPaths(["id"]);
      assert.deepStrictEqual(tree, { id: {} });
    });

    test("wildcard path creates literal * node", () => {
      const tree = buildSelectionTreeFromPaths(["legs.*"]);
      assert.deepStrictEqual(tree, { legs: { "*": {} } });
    });

    test("bare object path creates empty leaf", () => {
      const tree = buildSelectionTreeFromPaths(["legs"]);
      assert.deepStrictEqual(tree, { legs: {} });
    });

    test("nested path creates nested tree", () => {
      const tree = buildSelectionTreeFromPaths(["legs.c.c1"]);
      assert.deepStrictEqual(tree, { legs: { c: { c1: {} } } });
    });
  });

  // ── Wildcard: fields: ["id", "legs.*"] ──────────────────────────────────
  //
  // Should generate: { travel(id: $id) { id legs { a b } } }
  // Only scalar sub-fields of `legs` are included (not `c` which is an object).

  describe('fields: ["id", "legs.*"] — wildcard selects scalars only', () => {
    test("generated query includes only scalar sub-fields of legs", () => {
      const schema = buildGraphQLSchema(testSDL);
      const expectedData = { id: 1, legs: { a: "x", b: 2 } };

      const source = buildGraphQLOperationSource(
        schema,
        "Query.travel",
        expectedData,
        ["id", "legs.*"],
      );

      // Should select `a` and `b` (scalars), but NOT `c` (object)
      assert.ok(source.includes("legs"), "query should include legs");
      assert.ok(source.includes(" a"), "query should include scalar field a");
      assert.ok(source.includes(" b"), "query should include scalar field b");
      assert.ok(
        !source.includes(" c"),
        "query should NOT include object field c",
      );
    });
  });

  // ── Full selector: fields: ["id", "legs"] ───────────────────────────────
  //
  // Should generate: { travel(id: $id) { id legs } }
  // The schema must have `legs` typed as JSONObject (no sub-selection needed).

  describe('fields: ["id", "legs"] — bare leaf uses JSONObject schema', () => {
    test("collectFieldsRequiringJSONObject finds legs as needing JSONObject", () => {
      const schema = buildGraphQLSchema(testSDL);
      const scenarios: Record<string, Scenario> = {
        "full object": {
          input: { id: 1 },
          fields: ["id", "legs"],
          assertData: { id: 1, legs: { a: "x", b: 2, c: { c1: "y", c2: 3 } } },
          assertTraces: 1,
        },
      };

      const result = collectFieldsRequiringJSONObject(
        schema,
        "Query.travel",
        scenarios,
        Object.keys(scenarios),
      );

      assert.ok(result.has("TravelResult"), "should identify TravelResult");
      assert.ok(
        result.get("TravelResult")!.has("legs"),
        "should flag legs for JSONObject replacement",
      );
    });

    test("replaceFieldTypesWithJSONObject rewrites legs type in SDL", () => {
      const fieldsToReplace = new Map([
        ["TravelResult", new Set(["legs"])],
      ]);
      const modified = replaceFieldTypesWithJSONObject(testSDL, fieldsToReplace);

      assert.ok(
        modified.includes("scalar JSONObject"),
        "should add JSONObject scalar declaration",
      );
      assert.ok(
        modified.includes("legs: JSONObject"),
        "should replace legs type with JSONObject",
      );
    });

    test("generated query has bare legs field with no sub-selection", () => {
      const fieldsToReplace = new Map([
        ["TravelResult", new Set(["legs"])],
      ]);
      const modifiedSDL = replaceFieldTypesWithJSONObject(
        testSDL,
        fieldsToReplace,
      );
      const schema = buildGraphQLSchema(modifiedSDL);
      const expectedData = { id: 1, legs: { a: "x", b: 2 } };

      const source = buildGraphQLOperationSource(
        schema,
        "Query.travel",
        expectedData,
        ["id", "legs"],
      );

      // legs should appear without sub-selection because it's now JSONObject
      assert.ok(source.includes("legs"), "query should include legs");
      assert.ok(
        !source.includes("legs {"),
        "legs should NOT have sub-field selection",
      );
    });
  });

  // ── Scalar leaf is not affected ─────────────────────────────────────────

  describe("scalar field is not flagged for JSONObject", () => {
    test("scalar leaf field is not collected for replacement", () => {
      const schema = buildGraphQLSchema(testSDL);
      const scenarios: Record<string, Scenario> = {
        scalar: {
          input: { id: 1 },
          fields: ["id"],
          assertData: { id: 1 },
          assertTraces: 0,
        },
      };

      const result = collectFieldsRequiringJSONObject(
        schema,
        "Query.travel",
        scenarios,
        Object.keys(scenarios),
      );

      assert.equal(result.size, 0, "no fields should need JSONObject");
    });
  });

  // ── Nested dotted path is not affected ──────────────────────────────────

  describe("dotted sub-field path does not trigger JSONObject", () => {
    test("path like legs.c.c1 does not replace legs", () => {
      const schema = buildGraphQLSchema(testSDL);
      const scenarios: Record<string, Scenario> = {
        nested: {
          input: { id: 1 },
          fields: ["legs.c.c1"],
          assertData: { legs: { c: { c1: "val" } } },
          assertTraces: 0,
        },
      };

      const result = collectFieldsRequiringJSONObject(
        schema,
        "Query.travel",
        scenarios,
        Object.keys(scenarios),
      );

      // legs.c.c1 drills into legs, so legs is NOT a leaf
      assert.equal(result.size, 0, "no fields should need JSONObject");
    });
  });
});
