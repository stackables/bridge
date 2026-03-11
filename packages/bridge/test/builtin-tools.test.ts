import assert from "node:assert/strict";
import { describe } from "node:test";
import { std } from "@stackables/bridge-stdlib";
import { regressionTest } from "./utils/regression.ts";

// ── String builtins ─────────────────────────────────────────────────────────
// Single bridge exercises toUpperCase, toLowerCase, trim, length all at once.

describe("builtin tools", () => {
  regressionTest("string builtins", {
    bridge: `
      version 1.5
      bridge Query.format {
        with std.str.toUpperCase as up
        with std.str.toLowerCase as lo
        with std.str.trim as trim
        with std.str.length as len
        with input as i
        with output as o

        o.upper <- up:i.text
        o.lower <- lo:i.text
        o.trimmed <- trim:i.text
        o.len <- len:i.text
      }
    `,
    scenarios: {
      "Query.format": {
        "all string operations": {
          input: { text: "  Hello  " },
          assertData: (data) => {
            assert.equal(data.upper, "  HELLO  ");
            assert.equal(data.lower, "  hello  ");
            assert.equal(data.trimmed, "Hello");
            assert.equal(data.len, 9);
          },
        },
        "std override replaces tools": {
          input: { text: "Hello" },
          tools: {
            std: {
              str: {
                toUpperCase: (opts: any) =>
                  opts.in.split("").reverse().join(""),
                toLowerCase: (opts: any) => opts.in,
                trim: (opts: any) => opts.in,
                length: (opts: any) => opts.in.length,
              },
            },
          },
          assertData: (data) => {
            assert.equal(data.upper, "olleH");
          },
        },
        "missing std tool when namespace overridden": {
          input: { text: "Hello" },
          tools: {
            std: { somethingElse: () => ({}) },
          },
          assertError: () => {},
        },
      },
    },
  });

  // ── Custom tools alongside std ──────────────────────────────────────────

  regressionTest("custom tools alongside std", {
    bridge: `
      version 1.5
      bridge Query.process {
        with std.str.toUpperCase as up
        with reverse as rev
        with input as i
        with output as o

        o.upper <- up:i.text
        o.custom <- rev:i.text
      }
    `,
    tools: {
      reverse: (opts: any) => opts.in.split("").reverse().join(""),
    },
    scenarios: {
      "Query.process": {
        "custom tools merge alongside std": {
          input: { text: "Hello" },
          assertData: (data) => {
            assert.equal(data.upper, "HELLO");
            assert.equal(data.custom, "olleH");
          },
        },
      },
    },
  });

  // ── Array filter ────────────────────────────────────────────────────────

  regressionTest("array filter", {
    bridge: `
      version 1.5
      bridge Query.admins {
        with getUsers as db
        with std.arr.filter as filter
        with output as o

        filter.in <- db.users
        filter.role = "admin"
        o <- filter[] as u {
          .id <- u.id
          .name <- u.name
        }
      }
    `,
    tools: {
      getUsers: async () => ({
        users: [
          { id: 1, name: "Alice", role: "admin" },
          { id: 2, name: "Bob", role: "editor" },
          { id: 3, name: "Charlie", role: "admin" },
        ],
      }),
    },
    scenarios: {
      "Query.admins": {
        "filters array by criteria": {
          input: {},
          allowDowngrade: true,
          assertData: (data) => {
            assert.deepEqual(data, [
              { id: 1, name: "Alice" },
              { id: 3, name: "Charlie" },
            ]);
          },
        },
        "empty when no matches": {
          input: {},
          allowDowngrade: true,
          tools: {
            getUsers: async () => ({
              users: [{ id: 2, name: "Bob", role: "editor" }],
            }),
          },
          assertData: (data) => {
            assert.deepEqual(data, []);
          },
        },
      },
    },
  });

  // ── Array find ──────────────────────────────────────────────────────────

  regressionTest("array find", {
    bridge: `
      version 1.5
      bridge Query.findUser {
        with getUsers as db
        with std.arr.find as find
        with input as i
        with output as o

        find.in <- db.users
        find.role <- i.role
        o.id <- find.id
        o.name <- find.name
        o.role <- find.role
      }
    `,
    tools: {
      getUsers: async () => ({
        users: [
          { id: 1, name: "Alice", role: "admin" },
          { id: 2, name: "Bob", role: "editor" },
          { id: 3, name: "Charlie", role: "viewer" },
        ],
      }),
    },
    scenarios: {
      "Query.findUser": {
        "finds object in array": {
          input: { role: "editor" },
          allowDowngrade: true,
          assertData: (data) => {
            assert.deepEqual(data, { id: 2, name: "Bob", role: "editor" });
          },
        },
      },
    },
  });

  // ── Array first ─────────────────────────────────────────────────────────

  regressionTest("array first", {
    bridge: `
      version 1.5
      bridge Query.first {
        with std.arr.first as pf
        with input as i
        with output as o

        o.value <- pf:i.items
      }
    `,
    scenarios: {
      "Query.first": {
        "picks first element via pipe": {
          input: { items: ["a", "b", "c"] },
          assertData: (data) => {
            assert.equal(data.value, "a");
          },
        },
      },
    },
  });

  // ── Array first strict mode ─────────────────────────────────────────────

  regressionTest("array first strict mode", {
    bridge: `
      version 1.5
      tool pf from std.arr.first {
        .strict = true
      }
      bridge Query.onlyOne {
        with pf
        with input as i
        with output as o

        pf.in <- i.items
        o.value <- pf
      }
    `,
    scenarios: {
      "Query.onlyOne": {
        "strict passes with one element": {
          input: { items: ["only"] },
          assertData: (data) => {
            assert.equal(data.value, "only");
          },
        },
        "strict errors with multiple elements": {
          input: { items: ["a", "b"] },
          assertError: () => {},
        },
      },
    },
  });

  // ── toArray ─────────────────────────────────────────────────────────────

  regressionTest("toArray", {
    bridge: `
      version 1.5
      bridge Query.normalize {
        with std.arr.toArray as ta
        with std.arr.first as pf
        with countItems as cnt
        with input as i
        with output as o

        o.roundTrip <- pf:ta:i.value
        cnt.in <- ta:i.value
        o.count <- cnt.count
      }
    `,
    tools: {
      countItems: (opts: any) => ({ count: opts.in.length }),
    },
    scenarios: {
      "Query.normalize": {
        "round-trip and normalization": {
          input: { value: "hello" },
          assertData: (data) => {
            assert.equal(data.roundTrip, "hello");
            assert.equal(data.count, 1);
          },
        },
      },
    },
  });

  // ── Audit with force ──────────────────────────────────────────────────────

  regressionTest("audit with force", {
    bridge: `
      version 1.5
      bridge Query.search {
        with searchApi as api
        with std.audit as audit
        with input as i
        with output as o

        api.q <- i.q
        audit.action = "search"
        audit.query <- i.q
        audit.resultTitle <- api.title
        force audit
        o.title <- api.title
      }
    `,
    tools: {
      searchApi: async (input: any) => ({ title: `Result for ${input.q}` }),
    },
    scenarios: {
      "Query.search": {
        "forced audit logs via engine logger": {
          input: { q: "bridge" },
          assertData: (data) => {
            assert.equal(data.title, "Result for bridge");
          },
          assertLogs: (logs) => {
            const auditEntry = logs.find(
              (l) => l.level === "info" && l.args[1] === "[bridge:audit]",
            );
            assert.ok(auditEntry, "audit logged via engine logger");
            const payload = auditEntry!.args[0];
            assert.equal(payload.action, "search");
            assert.equal(payload.query, "bridge");
            assert.equal(payload.resultTitle, "Result for bridge");
          },
        },
        "critical audit failure propagates error": {
          input: { q: "test" },
          tools: {
            searchApi: async () => ({ title: "OK" }),
            std: {
              ...std,
              audit: () => {
                throw new Error("audit down");
              },
            },
          },
          assertError: () => {},
        },
      },
    },
  });

  // ── Audit fire-and-forget ─────────────────────────────────────────────────

  regressionTest("audit fire-and-forget", {
    bridge: `
      version 1.5
      bridge Query.search {
        with searchApi as api
        with std.audit as audit
        with input as i
        with output as o

        api.q <- i.q
        audit.query <- i.q
        force audit catch null
        o.title <- api.title
      }
    `,
    tools: {
      searchApi: async () => ({ title: "OK" }),
      std: {
        ...std,
        audit: () => {
          throw new Error("audit down");
        },
      },
    },
    scenarios: {
      "Query.search": {
        "catch null swallows audit error": {
          input: { q: "test" },
          assertData: (data) => {
            assert.equal(data.title, "OK");
          },
        },
      },
    },
  });
});
