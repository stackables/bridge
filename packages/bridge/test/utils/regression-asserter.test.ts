import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { assertGraphqlExpectation } from "../utils/regression.ts";

describe("assertGraphql asserter", () => {
  test("rejects partial object expectations for multi-field GraphQL results", () => {
    assert.throws(
      () =>
        assertGraphqlExpectation(
          {
            twoSource: /boom/i,
          },
          {
            twoSource: null,
            threeSource: null,
            withLiteral: null,
            withCatch: "error-default",
          },
          [{ path: ["lookup", "twoSource"], message: "boom" }],
        ),
      /must deep-equal GraphQL data/i,
    );
  });

  test("accepts complete object expectations for multi-field GraphQL results", () => {
    assert.doesNotThrow(() =>
      assertGraphqlExpectation(
        {
          twoSource: /boom/i,
          threeSource: null,
          withLiteral: null,
          withCatch: "error-default",
        },
        {
          twoSource: null,
          threeSource: null,
          withLiteral: null,
          withCatch: "error-default",
        },
        [{ path: ["lookup", "twoSource"], message: "boom" }],
      ),
    );
  });

  test("supports nested regex expectations by matching error paths and null-normalized data", () => {
    assert.doesNotThrow(() =>
      assertGraphqlExpectation(
        {
          profile: {
            name: "Alice",
            contact: {
              email: /not available/i,
            },
          },
        },
        {
          profile: {
            name: "Alice",
            contact: {
              email: null,
            },
          },
        },
        [
          {
            path: ["lookup", "profile", "contact", "email"],
            message: "email not available",
          },
        ],
      ),
    );
  });

  test("rejects nested regex expectations when matching error path is missing", () => {
    assert.throws(
      () =>
        assertGraphqlExpectation(
          {
            profile: {
              contact: {
                email: /not available/i,
              },
            },
          },
          {
            profile: {
              contact: {
                email: null,
              },
            },
          },
          [],
        ),
      /Expected GraphQL error for field path "profile.contact.email"/i,
    );
  });
});
