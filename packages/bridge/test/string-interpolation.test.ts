import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  parseBridgeFormat as parseBridge,
  serializeBridge,
} from "../src/index.ts";
import { forEachEngine } from "./_dual-run.ts";

// ── String interpolation execution tests ────────────────────────────────────

forEachEngine("string interpolation", (run, ctx) => {
  test("simple placeholder", async () => {
    const bridge = `version 1.5
bridge Query.test {
  with input as i
  with output as o

  o.message <- "Hello, {i.name}!"
}`;
    const { data } = await run(bridge, "Query.test", { name: "World" });
    assert.deepEqual(data, { message: "Hello, World!" });
  });

  test("URL construction with placeholder", async () => {
    const bridge = `version 1.5
bridge Query.test {
  with input as i
  with output as o

  o.path <- "/users/{i.id}/orders"
}`;
    const { data } = await run(bridge, "Query.test", { id: "abc123" });
    assert.deepEqual(data, { path: "/users/abc123/orders" });
  });

  test("multiple placeholders", async () => {
    const bridge = `version 1.5
bridge Query.test {
  with input as i
  with output as o

  o.name <- "{i.first} {i.last}"
}`;
    const { data } = await run(bridge, "Query.test", {
      first: "John",
      last: "Doe",
    });
    assert.deepEqual(data, { name: "John Doe" });
  });

  test("plain string without placeholders", async () => {
    const bridge = `version 1.5
bridge Query.test {
  with input as i
  with output as o

  o.value <- "just a string"
}`;
    const { data } = await run(bridge, "Query.test", {});
    assert.deepEqual(data, { value: "just a string" });
  });

  test("numeric value coercion in placeholder", async () => {
    const bridge = `version 1.5
bridge Query.test {
  with input as i
  with output as o

  o.text <- "Count: {i.count}"
}`;
    const { data } = await run(bridge, "Query.test", { count: 42 });
    assert.deepEqual(data, { text: "Count: 42" });
  });

  test("null coercion in placeholder", async () => {
    const bridge = `version 1.5
bridge Query.test {
  with input as i
  with output as o

  o.text <- "Value: {i.missing}"
}`;
    const { data } = await run(bridge, "Query.test", { missing: null });
    assert.deepEqual(data, { text: "Value: " });
  });

  test("interpolation with tool output", async () => {
    const bridge = `version 1.5
bridge Query.test {
  with userApi as api
  with input as i
  with output as o

  api.id <- i.userId
  o.url <- "/users/{api.name}/profile"
}`;
    const tools = {
      userApi: async (_p: any) => ({ name: "john-doe" }),
    };
    const { data } = await run(bridge, "Query.test", { userId: "1" }, tools);
    assert.deepEqual(data, { url: "/users/john-doe/profile" });
  });

  // TODO: compiler doesn't support interpolation inside array element mapping yet
  test(
    "template in element lines",
    { skip: ctx.engine === "compiled" },
    async () => {
      const bridge = `version 1.5
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
    },
  );

  test("template with || fallback", async () => {
    const bridge = `version 1.5
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
    const src = `version 1.5
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
    const src = `version 1.5
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
    const src = `version 1.5
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
