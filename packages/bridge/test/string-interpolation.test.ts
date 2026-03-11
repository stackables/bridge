import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  parseBridgeFormat as parseBridge,
  serializeBridge,
} from "../src/index.ts";
import { regressionTest } from "./utils/regression.ts";
import { tools } from "./utils/bridge-tools.ts";

// ── String interpolation execution tests ────────────────────────────────────

regressionTest("string interpolation", {
  bridge: `
    version 1.5

    bridge Interpolation.basic {
      with input as i
      with output as o

      o.message <- "Hello, {i.name}!"
      o.path <- "/users/{i.id}/orders"
      o.fullName <- "{i.first} {i.last}"
      o.plain <- "just a string"
      o.coerced <- "Count: {i.count}"
      o.nullCoerce <- "Value: {i.missing}"
    }

    bridge Interpolation.withTool {
      with test.multitool as api
      with input as i
      with output as o

      api <- i.api
      o.url <- "/users/{api.name}/profile"
    }

    bridge Interpolation.array {
      with input as i
      with output as o

      o <- i.items[] as it {
        .url <- "/items/{it.id}"
        .label <- "{it.name} (#{it.id})"
      }
    }
  `,
  tools: tools,
  scenarios: {
    "Interpolation.basic": {
      "simple placeholder": {
        input: {
          name: "World",
          id: "abc123",
          first: "John",
          last: "Doe",
          count: 42,
          missing: null,
        },
        assertData: {
          message: "Hello, World!",
          path: "/users/abc123/orders",
          fullName: "John Doe",
          plain: "just a string",
          coerced: "Count: 42",
          nullCoerce: "Value: ",
        },
        assertTraces: 0,
      },
    },
    "Interpolation.withTool": {
      "interpolation with tool output": {
        input: { api: { name: "john-doe" } },
        assertData: { url: "/users/john-doe/profile" },
        assertTraces: 1,
      },
      "tool error → interpolation fails": {
        input: { api: { _error: "api down" } },
        assertError: /api down/,
        assertTraces: 1,
      },
    },
    "Interpolation.array": {
      "template in element lines": {
        input: {
          items: [
            { id: "1", name: "Widget" },
            { id: "2", name: "Gadget" },
          ],
        },
        assertData: [
          { url: "/items/1", label: "Widget (#1)" },
          { url: "/items/2", label: "Gadget (#2)" },
        ],
        assertTraces: 0,
      },
      "empty array": {
        input: { items: [] },
        assertData: [],
        assertTraces: 0,
      },
    },
  },
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
