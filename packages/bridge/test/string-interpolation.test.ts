import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBridge, serializeBridge } from "../src/bridge-format.ts";
import { executeBridge } from "../src/execute-bridge.ts";
import { concat } from "../src/tools/concat.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function run(
  bridgeText: string,
  operation: string,
  input: Record<string, unknown>,
  tools: Record<string, any> = {},
) {
  const raw = parseBridge(bridgeText);
  const instructions = JSON.parse(JSON.stringify(raw)) as ReturnType<typeof parseBridge>;
  return executeBridge({ instructions, operation, input, tools });
}

// ── concat tool unit tests ──────────────────────────────────────────────────

describe("std.concat tool", () => {
  test("joins string parts", () => {
    assert.deepEqual(concat({ parts: ["Hello", ", ", "World!"] }), { value: "Hello, World!" });
  });

  test("coerces numbers to strings", () => {
    assert.deepEqual(concat({ parts: ["Count: ", 42] }), { value: "Count: 42" });
  });

  test("coerces null and undefined to empty strings", () => {
    assert.deepEqual(concat({ parts: ["a", null, "b", undefined, "c"] }), { value: "abc" });
  });

  test("coerces booleans", () => {
    assert.deepEqual(concat({ parts: ["is: ", true] }), { value: "is: true" });
  });

  test("empty parts produces empty string", () => {
    assert.deepEqual(concat({ parts: [] }), { value: "" });
  });
});

// ── String interpolation execution tests ────────────────────────────────────

describe("string interpolation: basic", () => {
  test("simple placeholder", async () => {
    const bridge = `version 1.4
bridge Query.test {
  with input as i
  with output as o

  o.message <- "Hello, {i.name}!"
}`;
    const { data } = await run(bridge, "Query.test", { name: "World" });
    assert.deepEqual(data, { message: "Hello, World!" });
  });

  test("URL construction with placeholder", async () => {
    const bridge = `version 1.4
bridge Query.test {
  with input as i
  with output as o

  o.path <- "/users/{i.id}/orders"
}`;
    const { data } = await run(bridge, "Query.test", { id: "abc123" });
    assert.deepEqual(data, { path: "/users/abc123/orders" });
  });

  test("multiple placeholders", async () => {
    const bridge = `version 1.4
bridge Query.test {
  with input as i
  with output as o

  o.name <- "{i.first} {i.last}"
}`;
    const { data } = await run(bridge, "Query.test", { first: "John", last: "Doe" });
    assert.deepEqual(data, { name: "John Doe" });
  });

  test("plain string without placeholders", async () => {
    const bridge = `version 1.4
bridge Query.test {
  with input as i
  with output as o

  o.value <- "just a string"
}`;
    const { data } = await run(bridge, "Query.test", {});
    assert.deepEqual(data, { value: "just a string" });
  });

  test("numeric value coercion in placeholder", async () => {
    const bridge = `version 1.4
bridge Query.test {
  with input as i
  with output as o

  o.text <- "Count: {i.count}"
}`;
    const { data } = await run(bridge, "Query.test", { count: 42 });
    assert.deepEqual(data, { text: "Count: 42" });
  });

  test("null coercion in placeholder", async () => {
    const bridge = `version 1.4
bridge Query.test {
  with input as i
  with output as o

  o.text <- "Value: {i.missing}"
}`;
    const { data } = await run(bridge, "Query.test", { missing: null });
    assert.deepEqual(data, { text: "Value: " });
  });
});

describe("string interpolation: tool interaction", () => {
  test("interpolation with tool output", async () => {
    const bridge = `version 1.4
bridge Query.test {
  with userApi as api
  with input as i
  with output as o

  api.id <- i.userId
  o.url <- "/users/{api.name}/profile"
}`;
    const tools = {
      userApi: async (p: any) => ({ name: "john-doe" }),
    };
    const { data } = await run(bridge, "Query.test", { userId: "1" }, tools);
    assert.deepEqual(data, { url: "/users/john-doe/profile" });
  });
});

describe("string interpolation: array mapping", () => {
  test("template in element lines", async () => {
    const bridge = `version 1.4
bridge Query.test {
  with input as i
  with output as o

  o <- i.items[] as it {
    .url <- "/items/{it.id}"
    .label <- "{it.name} (#{it.id})"
  }
}`;
    const { data } = await run(bridge, "Query.test", {
      items: [
        { id: "1", name: "Widget" },
        { id: "2", name: "Gadget" },
      ],
    });
    assert.deepEqual(data, [
      { url: "/items/1", label: "Widget (#1)" },
      { url: "/items/2", label: "Gadget (#2)" },
    ]);
  });
});

describe("string interpolation: fallback chains", () => {
  test("template with || fallback", async () => {
    const bridge = `version 1.4
bridge Query.test {
  with input as i
  with output as o

  o.greeting <- "Hello, {i.name}!" || "Hello, stranger!"
}`;
    const { data } = await run(bridge, "Query.test", { name: "World" });
    assert.deepEqual(data, { greeting: "Hello, World!" });
  });
});

// ── Formatter round-trip tests ──────────────────────────────────────────────

describe("string interpolation: formatter round-trip", () => {
  test("basic template string round-trips", () => {
    const src = `version 1.4
bridge Query.test {
  with input as i
  with output as o

  o.greeting <- "Hello, {i.name}!"
}`;
    const parsed = parseBridge(src);
    const formatted = serializeBridge(parsed);
    assert.ok(formatted.includes('o.greeting <- "Hello, {i.name}!"'));

    const parsed2 = parseBridge(formatted);
    const formatted2 = serializeBridge(parsed2);
    assert.equal(formatted, formatted2, "round-trip should be stable");
  });

  test("URL template round-trips", () => {
    const src = `version 1.4
bridge Query.test {
  with input as i
  with output as o

  o.url <- "/users/{i.id}/orders"
}`;
    const parsed = parseBridge(src);
    const formatted = serializeBridge(parsed);
    assert.ok(formatted.includes('o.url <- "/users/{i.id}/orders"'));
  });

  test("multiple fields with templates round-trip", () => {
    const src = `version 1.4
bridge Query.test {
  with input as i
  with output as o

  o.name <- "{i.first} {i.last}"
  o.greeting <- "Hello, {i.first}!"
}`;
    const parsed = parseBridge(src);
    const formatted = serializeBridge(parsed);
    assert.ok(formatted.includes('o.name <- "{i.first} {i.last}"'));
    assert.ok(formatted.includes('o.greeting <- "Hello, {i.first}!"'));

    const parsed2 = parseBridge(formatted);
    const formatted2 = serializeBridge(parsed2);
    assert.equal(formatted, formatted2);
  });
});
