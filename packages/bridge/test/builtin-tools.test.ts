import assert from "node:assert/strict";
import { test } from "node:test";
import { std } from "@stackables/bridge-stdlib";
import { forEachEngine } from "./utils/dual-run.ts";

// ── Default tools behaviour ─────────────────────────────────────────────────

forEachEngine("default tools (no tools option)", (run) => {
  test("upperCase and lowerCase are available by default", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.greet {
  with std.str.toUpperCase as up
  with std.str.toLowerCase as lo
  with input as i
  with output as o

o.upper <- up:i.name
o.lower <- lo:i.name

}`,
      "Query.greet",
      { name: "Hello" },
    );
    assert.equal(data.upper, "HELLO");
    assert.equal(data.lower, "hello");
  });
});

forEachEngine("user can override std namespace", (run) => {
  const bridgeText = `version 1.5
bridge Query.greet {
  with std.str.toUpperCase as up
  with input as i
  with output as o

o.upper <- up:i.name

}`;

  test("overriding std replaces its tools", async () => {
    const { data } = await run(
      bridgeText,
      "Query.greet",
      { name: "Hello" },
      {
        std: {
          str: {
            toUpperCase: (opts: any) => opts.in.split("").reverse().join(""),
          },
        },
      },
    );
    assert.equal(data.upper, "olleH");
  });

  test("missing std tool when namespace overridden", async () => {
    await assert.rejects(() =>
      run(
        bridgeText,
        "Query.greet",
        { name: "Hello" },
        {
          std: { somethingElse: () => ({}) },
        },
      ),
    );
  });
});

forEachEngine("user can add custom tools alongside std", (run) => {
  test("custom tools merge alongside std automatically", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.process {
  with std.str.toUpperCase as up
  with reverse as rev
  with input as i
  with output as o

o.upper <- up:i.text
o.custom <- rev:i.text

}`,
      "Query.process",
      { text: "Hello" },
      {
        reverse: (opts: any) => opts.in.split("").reverse().join(""),
      },
    );
    assert.equal(data.upper, "HELLO");
    assert.equal(data.custom, "olleH");
  });
});

// ── filterArray through bridge ──────────────────────────────────────────────

forEachEngine("filterArray through bridge", (run, { engine }) => {
  test(
    "filters array by criteria through bridge",
    { skip: engine === "compiled" },
    async () => {
      const { data } = await run(
        `version 1.5
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

}`,
        "Query.admins",
        {},
        {
          getUsers: async () => ({
            users: [
              { id: 1, name: "Alice", role: "admin" },
              { id: 2, name: "Bob", role: "editor" },
              { id: 3, name: "Charlie", role: "admin" },
            ],
          }),
        },
      );
      assert.deepEqual(data, [
        { id: 1, name: "Alice" },
        { id: 3, name: "Charlie" },
      ]);
    },
  );
});

// ── findObject through bridge ───────────────────────────────────────────────

forEachEngine("findObject through bridge", (run, { engine }) => {
  test(
    "finds object in array returned by another tool",
    { skip: engine === "compiled" },
    async () => {
      const { data } = await run(
        `version 1.5
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

}`,
        "Query.findUser",
        { role: "editor" },
        {
          getUsers: async () => ({
            users: [
              { id: 1, name: "Alice", role: "admin" },
              { id: 2, name: "Bob", role: "editor" },
              { id: 3, name: "Charlie", role: "viewer" },
            ],
          }),
        },
      );
      assert.deepEqual(data, { id: 2, name: "Bob", role: "editor" });
    },
  );
});

// ── Pipe with built-in tools ────────────────────────────────────────────────

forEachEngine("pipe with built-in tools", (run) => {
  test("pipe through upperCase", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.shout {
  with std.str.toUpperCase as up
  with input as i
  with output as o

o.value <- up:i.text

}`,
      "Query.shout",
      { text: "whisper" },
    );
    assert.equal(data.value, "WHISPER");
  });
});

// ── trim through bridge ─────────────────────────────────────────────────────

forEachEngine("trim through bridge", (run) => {
  test("trims whitespace via pipe", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.clean {
  with std.str.trim as trim
  with input as i
  with output as o

o.value <- trim:i.text

}`,
      "Query.clean",
      { text: "  hello  " },
    );
    assert.equal(data.value, "hello");
  });
});

// ── length through bridge ───────────────────────────────────────────────────

forEachEngine("length through bridge", (run) => {
  test("returns string length via pipe", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.measure {
  with std.str.length as len
  with input as i
  with output as o

o.value <- len:i.text

}`,
      "Query.measure",
      { text: "hello" },
    );
    assert.equal(data.value, 5);
  });
});

// ── pickFirst through bridge ────────────────────────────────────────────────

forEachEngine("pickFirst through bridge", (run) => {
  test("picks first element via pipe", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.first {
  with std.arr.first as pf
  with input as i
  with output as o

o.value <- pf:i.items

}`,
      "Query.first",
      { items: ["a", "b", "c"] },
    );
    assert.equal(data.value, "a");
  });
});

forEachEngine("pickFirst strict through bridge", (run) => {
  const bridgeText = `version 1.5
tool pf from std.arr.first {
  .strict = true

}
bridge Query.onlyOne {
  with pf
  with input as i
  with output as o

pf.in <- i.items
o.value <- pf

}`;

  test("strict mode passes with one element", async () => {
    const { data } = await run(bridgeText, "Query.onlyOne", {
      items: ["only"],
    });
    assert.equal(data.value, "only");
  });

  test("strict mode errors with multiple elements", async () => {
    await assert.rejects(() =>
      run(bridgeText, "Query.onlyOne", { items: ["a", "b"] }),
    );
  });
});

// ── toArray through bridge ──────────────────────────────────────────────────

forEachEngine("toArray through bridge", (run) => {
  test("toArray + pickFirst round-trip via pipe chain", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.normalize {
  with std.arr.toArray as ta
  with std.arr.first as pf
  with input as i
  with output as o

o.value <- pf:ta:i.value

}`,
      "Query.normalize",
      { value: "hello" },
    );
    assert.equal(data.value, "hello");
  });
});

forEachEngine("toArray as tool input normalizer", (run) => {
  test("toArray normalizes scalar into array for downstream tool", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.wrap {
  with std.arr.toArray as ta
  with countItems as cnt
  with input as i
  with output as o

cnt.in <- ta:i.value
o.count <- cnt.count

}`,
      "Query.wrap",
      { value: "hello" },
      {
        countItems: (opts: any) => ({ count: opts.in.length }),
      },
    );
    assert.equal(data.count, 1);
  });
});

// ── Inline with (no tool block needed) ──────────────────────────────────────

forEachEngine("inline with — no tool block", (run) => {
  test("built-in tools work without tool blocks", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.format {
  with std.str.toUpperCase as up
  with std.str.toLowerCase as lo
  with input as i
  with output as o

o.upper <- up:i.text
o.lower <- lo:i.text

}`,
      "Query.format",
      { text: "Hello" },
    );
    assert.equal(data.upper, "HELLO");
    assert.equal(data.lower, "hello");
  });
});

// ── audit + force e2e ───────────────────────────────────────────────────────

forEachEngine("audit tool with force (e2e)", (run, { engine }) => {
  test("forced audit logs via engine logger (ToolContext flow)", async () => {
    const logged: any[] = [];
    const logger = { info: (...args: any[]) => logged.push(args) };

    const { data } = await run(
      `version 1.5
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

}`,
      "Query.search",
      { q: "bridge" },
      {
        searchApi: async (input: any) => ({ title: `Result for ${input.q}` }),
      },
      { logger },
    );

    assert.equal(data.title, "Result for bridge");
    const auditEntry = logged.find((l) => l[1] === "[bridge:audit]");
    assert.ok(auditEntry, "audit logged via engine logger");
    const payload = auditEntry[0];
    assert.equal(payload.action, "search");
    assert.equal(payload.query, "bridge");
    assert.equal(payload.resultTitle, "Result for bridge");
  });

  test(
    "fire-and-forget audit failure does not break response",
    { skip: engine === "runtime" },
    async () => {
      const failAudit = () => {
        throw new Error("audit down");
      };

      const { data } = await run(
        `version 1.5
bridge Query.search {
  with searchApi as api
  with std.audit as audit
  with input as i
  with output as o

  api.q <- i.q
  audit.query <- i.q
  force audit catch null
  o.title <- api.title

}`,
        "Query.search",
        { q: "test" },
        {
          searchApi: async (_input: any) => ({ title: "OK" }),
          std: { ...std, audit: failAudit },
        },
      );

      assert.equal(data.title, "OK");
    },
  );

  test("critical audit failure propagates error", async () => {
    const failAudit = () => {
      throw new Error("audit down");
    };

    await assert.rejects(() =>
      run(
        `version 1.5
bridge Query.search {
  with searchApi as api
  with std.audit as audit
  with input as i
  with output as o

  api.q <- i.q
  audit.query <- i.q
  force audit
  o.title <- api.title

}`,
        "Query.search",
        { q: "test" },
        {
          searchApi: async (_input: any) => ({ title: "OK" }),
          std: { ...std, audit: failAudit },
        },
      ),
    );
  });
});
