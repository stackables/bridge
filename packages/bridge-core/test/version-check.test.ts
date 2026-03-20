import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  getBridgeVersion,
  checkStdVersion,
  resolveStd,
  collectVersionedHandles,
  hasVersionedToolFn,
  checkHandleVersions,
} from "../src/version-check.ts";
import type { BridgeDocument, ToolMap } from "../src/types.ts";

const noopFn = () => {};
const bundledStd: ToolMap = {
  str: { toUpperCase: noopFn, toLowerCase: noopFn },
  math: { add: noopFn },
};

describe("getBridgeVersion", () => {
  test("returns version when present", () => {
    const doc: BridgeDocument = { version: "1.5", instructions: [] };
    assert.equal(getBridgeVersion(doc), "1.5");
  });
  test("returns undefined when absent", () => {
    const doc: BridgeDocument = { instructions: [] };
    assert.equal(getBridgeVersion(doc), undefined);
  });
});

describe("checkStdVersion", () => {
  test("passes when no version declared", () => {
    assert.doesNotThrow(() => checkStdVersion(undefined, "1.0.0"));
  });
  test("passes when std minor >= bridge minor (same major)", () => {
    assert.doesNotThrow(() => checkStdVersion("1.2", "1.3.0"));
    assert.doesNotThrow(() => checkStdVersion("1.2", "1.2.0"));
  });
  test("throws when bridge minor > std minor", () => {
    assert.throws(
      () => checkStdVersion("1.5", "1.3.0"),
      /requires standard library/,
    );
  });
  test("throws when major versions differ", () => {
    assert.throws(
      () => checkStdVersion("2.0", "1.5.0"),
      /requires a 2\.x standard library/,
    );
  });
});

describe("resolveStd", () => {
  test("returns bundled std when no version declared", () => {
    const result = resolveStd(undefined, bundledStd, "1.0.0");
    assert.equal(result.namespace, bundledStd);
    assert.equal(result.version, "1.0.0");
  });

  test("returns bundled std when bridge version satisfied by bundled", () => {
    const result = resolveStd("1.2", bundledStd, "1.3.0");
    assert.equal(result.namespace, bundledStd);
  });

  test("returns user-provided versioned std namespace", () => {
    const altStd: ToolMap = { altFn: noopFn };
    const userTools: ToolMap = { "std@2.0": altStd as unknown as ToolMap };
    const result = resolveStd("2.0", bundledStd, "1.5.0", userTools);
    assert.equal(result.namespace, altStd);
    assert.equal(result.version, "2.0.0");
  });

  test("resolveStd versioned std with full version string", () => {
    const altStd: ToolMap = { altFn: noopFn };
    const userTools: ToolMap = { "std@2.1.3": altStd as unknown as ToolMap };
    const result = resolveStd("2.1", bundledStd, "1.5.0", userTools);
    assert.equal(result.namespace, altStd);
    assert.equal(result.version, "2.1.3");
  });

  test("throws when bridge major differs from bundled and no user std provided", () => {
    assert.throws(
      () => resolveStd("2.0", bundledStd, "1.5.0"),
      /requires a 2\.x standard library/,
    );
  });

  test("throws when bridge minor unsatisfied by bundled and no user std provided", () => {
    assert.throws(
      () => resolveStd("1.9", bundledStd, "1.5.0"),
      /requires standard library/,
    );
  });
});

describe("collectVersionedHandles", () => {
  test("collects versioned tool handles from bridge instruction", () => {
    const result = collectVersionedHandles([
      {
        kind: "bridge",
        type: "Query",
        field: "weather",
        handles: [
          { handle: "api", kind: "tool", name: "std.http", version: "1.5" },
          { handle: "noVersion", kind: "tool", name: "myTool" },
          { handle: "input", kind: "input" },
        ],
        body: [],
      },
    ]);
    assert.deepEqual(result, [{ name: "std.http", version: "1.5" }]);
  });

  test("collects versioned tool handles from define instruction", () => {
    const result = collectVersionedHandles([
      {
        kind: "define",
        name: "Auth",
        handles: [
          { handle: "auth", kind: "tool", name: "std.auth", version: "2.0" },
        ],
        body: [],
      },
    ]);
    assert.deepEqual(result, [{ name: "std.auth", version: "2.0" }]);
  });

  test("collects versioned deps from tool instruction", () => {
    const result = collectVersionedHandles([
      {
        kind: "tool",
        name: "myTool",
        handles: [
          { handle: "helper", kind: "tool", name: "std.str", version: "1.2" },
        ],
        body: [],
      },
    ]);
    assert.deepEqual(result, [{ name: "std.str", version: "1.2" }]);
  });

  test("returns empty array when no versioned handles", () => {
    const result = collectVersionedHandles([
      {
        kind: "bridge",
        type: "Query",
        field: "x",
        handles: [{ handle: "i", kind: "input" }],
        body: [],
      },
    ]);
    assert.deepEqual(result, []);
  });
});

describe("hasVersionedToolFn", () => {
  const tools: ToolMap = {
    "std@1.5": { str: { toUpperCase: noopFn } } as unknown as ToolMap,
    "myTool@2.0": noopFn as any,
    plain: noopFn as any,
  };

  test("resolves flat versioned key", () => {
    assert.equal(hasVersionedToolFn(tools, "myTool", "2.0"), true);
  });

  test("resolves versioned namespace key for dotted name", () => {
    assert.equal(hasVersionedToolFn(tools, "std.str.toUpperCase", "1.5"), true);
  });

  test("returns false when version not present", () => {
    assert.equal(hasVersionedToolFn(tools, "myTool", "3.0"), false);
  });

  test("returns false when tool not present", () => {
    assert.equal(hasVersionedToolFn(tools, "missing", "1.0"), false);
  });
});

describe("checkHandleVersions", () => {
  test("passes when all versioned tools are satisfied by std version", () => {
    const instructions = [
      {
        kind: "bridge" as const,
        type: "Query",
        field: "x",
        handles: [
          {
            handle: "str",
            kind: "tool" as const,
            name: "std.http",
            version: "1.2",
          },
        ],
        body: [],
      },
    ];
    assert.doesNotThrow(() =>
      checkHandleVersions(instructions, bundledStd, "1.5.0"),
    );
  });

  test("throws when std.* tool version exceeds std version", () => {
    const instructions = [
      {
        kind: "bridge" as const,
        type: "Query",
        field: "x",
        handles: [
          {
            handle: "str",
            kind: "tool" as const,
            name: "std.str.trim",
            version: "9.0",
          },
        ],
        body: [],
      },
    ];
    assert.throws(
      () => checkHandleVersions(instructions, bundledStd, "1.5.0"),
      /requires standard library/,
    );
  });

  test("throws for non-std tool with version not in tools map", () => {
    const instructions = [
      {
        kind: "bridge" as const,
        type: "Query",
        field: "x",
        handles: [
          {
            handle: "api",
            kind: "tool" as const,
            name: "myApi",
            version: "2.0",
          },
        ],
        body: [],
      },
    ];
    assert.throws(
      () => checkHandleVersions(instructions, {}, "1.5.0"),
      /is not available/,
    );
  });

  test("passes when non-std versioned tool IS in tools map", () => {
    const instructions = [
      {
        kind: "bridge" as const,
        type: "Query",
        field: "x",
        handles: [
          {
            handle: "api",
            kind: "tool" as const,
            name: "myApi",
            version: "2.0",
          },
        ],
        body: [],
      },
    ];
    const tools: ToolMap = { "myApi@2.0": noopFn as any };
    assert.doesNotThrow(() =>
      checkHandleVersions(instructions, tools, "1.5.0"),
    );
  });

  test("passes when there are no versioned handles", () => {
    const instructions = [
      {
        kind: "bridge" as const,
        type: "Query",
        field: "x",
        handles: [{ handle: "i", kind: "input" as const }],
        body: [],
      },
    ];
    assert.doesNotThrow(() => checkHandleVersions(instructions, {}, "1.0.0"));
  });
});
