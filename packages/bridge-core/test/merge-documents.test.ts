import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mergeBridgeDocuments } from "../src/merge-documents.ts";
import type { BridgeDocument } from "../src/types.ts";

const emptyDoc: BridgeDocument = { instructions: [] };

const weatherDoc: BridgeDocument = {
  version: "1.2",
  instructions: [
    { kind: "bridge", type: "Query", field: "weather", handles: [], body: [] },
  ],
};

const quotesDoc: BridgeDocument = {
  version: "1.3",
  instructions: [
    { kind: "bridge", type: "Query", field: "quotes", handles: [], body: [] },
  ],
};

describe("mergeBridgeDocuments", () => {
  test("returns empty doc when called with no arguments", () => {
    const result = mergeBridgeDocuments();
    assert.deepEqual(result, { instructions: [] });
  });

  test("returns the same doc when called with a single argument", () => {
    const result = mergeBridgeDocuments(weatherDoc);
    assert.equal(result, weatherDoc);
  });

  test("merges two docs, concatenating instructions", () => {
    const result = mergeBridgeDocuments(weatherDoc, quotesDoc);
    assert.equal(result.instructions.length, 2);
    assert.equal(result.instructions[0], weatherDoc.instructions[0]);
    assert.equal(result.instructions[1], quotesDoc.instructions[0]);
  });

  test("picks the highest minor version across merged docs", () => {
    const result = mergeBridgeDocuments(weatherDoc, quotesDoc);
    assert.equal(result.version, "1.3");
  });

  test("version is undefined when no doc has a version", () => {
    const a: BridgeDocument = {
      instructions: [
        { kind: "bridge", type: "Query", field: "a", handles: [], body: [] },
      ],
    };
    const b: BridgeDocument = {
      instructions: [
        { kind: "bridge", type: "Query", field: "b", handles: [], body: [] },
      ],
    };
    const result = mergeBridgeDocuments(a, b);
    assert.equal(result.version, undefined);
  });

  test("merges when only one doc has a version", () => {
    const result = mergeBridgeDocuments(weatherDoc, emptyDoc);
    assert.equal(result.version, "1.2");
  });

  test("throws on duplicate bridge name", () => {
    const a: BridgeDocument = {
      instructions: [
        {
          kind: "bridge",
          type: "Query",
          field: "weather",
          handles: [],
          body: [],
        },
      ],
    };
    const b: BridgeDocument = {
      instructions: [
        {
          kind: "bridge",
          type: "Query",
          field: "weather",
          handles: [],
          body: [],
        },
      ],
    };
    assert.throws(() => mergeBridgeDocuments(a, b), /duplicate/i);
  });

  test("throws on duplicate tool name", () => {
    const a: BridgeDocument = {
      instructions: [{ kind: "tool", name: "myTool", handles: [], body: [] }],
    };
    const b: BridgeDocument = {
      instructions: [{ kind: "tool", name: "myTool", handles: [], body: [] }],
    };
    assert.throws(() => mergeBridgeDocuments(a, b), /duplicate/i);
  });

  test("throws on duplicate const name", () => {
    const a: BridgeDocument = {
      instructions: [
        { kind: "const", name: "BASE_URL", value: '"https://a.com"' },
      ],
    };
    const b: BridgeDocument = {
      instructions: [
        { kind: "const", name: "BASE_URL", value: '"https://b.com"' },
      ],
    };
    assert.throws(() => mergeBridgeDocuments(a, b), /duplicate/i);
  });

  test("throws on duplicate define name", () => {
    const a: BridgeDocument = {
      instructions: [{ kind: "define", name: "Auth", handles: [], body: [] }],
    };
    const b: BridgeDocument = {
      instructions: [{ kind: "define", name: "Auth", handles: [], body: [] }],
    };
    assert.throws(() => mergeBridgeDocuments(a, b), /duplicate/i);
  });

  test("throws when merging docs with different major versions", () => {
    const v1: BridgeDocument = {
      version: "1.0",
      instructions: [
        { kind: "bridge", type: "Query", field: "a", handles: [], body: [] },
      ],
    };
    const v2: BridgeDocument = {
      version: "2.0",
      instructions: [
        { kind: "bridge", type: "Query", field: "b", handles: [], body: [] },
      ],
    };
    assert.throws(() => mergeBridgeDocuments(v1, v2), /major version/i);
  });

  test("merges three docs preserving all instructions", () => {
    const a: BridgeDocument = {
      instructions: [
        { kind: "bridge", type: "Query", field: "a", handles: [], body: [] },
      ],
    };
    const b: BridgeDocument = {
      instructions: [
        { kind: "bridge", type: "Query", field: "b", handles: [], body: [] },
      ],
    };
    const c: BridgeDocument = {
      instructions: [
        { kind: "bridge", type: "Query", field: "c", handles: [], body: [] },
      ],
    };
    const result = mergeBridgeDocuments(a, b, c);
    assert.equal(result.instructions.length, 3);
  });

  test("picks highest patch version", () => {
    const v1: BridgeDocument = {
      version: "1.0.3",
      instructions: [
        { kind: "bridge", type: "Query", field: "a", handles: [], body: [] },
      ],
    };
    const v2: BridgeDocument = {
      version: "1.0.5",
      instructions: [
        { kind: "bridge", type: "Query", field: "b", handles: [], body: [] },
      ],
    };
    const result = mergeBridgeDocuments(v1, v2);
    assert.equal(result.version, "1.0.5");
  });
});
