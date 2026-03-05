import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  parseBridgeFormat as parseBridge,
  serializeBridge,
} from "../src/index.ts";
import type { Bridge, Wire } from "../src/index.ts";
import { forEachEngine } from "./_dual-run.ts";

// ── Parser tests ────────────────────────────────────────────────────────────

describe("path scoping – parser", () => {
  test("simple scope block with constants", () => {
    const result = parseBridge(`version 1.5

bridge Query.test {
  with output as o

  o.settings {
    .theme = "dark"
    .lang = "en"
  }
}`);
    const bridge = result.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    assert.ok(bridge);
    const constWires = bridge.wires.filter(
      (w): w is Extract<Wire, { value: string }> => "value" in w,
    );
    assert.equal(constWires.length, 2);
    const theme = constWires.find(
      (w) => w.to.path.join(".") === "settings.theme",
    );
    const lang = constWires.find(
      (w) => w.to.path.join(".") === "settings.lang",
    );
    assert.ok(theme);
    assert.equal(theme.value, "dark");
    assert.ok(lang);
    assert.equal(lang.value, "en");
  });

  test("scope block with pull wires", () => {
    const result = parseBridge(`version 1.5

bridge Query.test {
  with input as i
  with output as o

  o.user {
    .name <- i.name
    .email <- i.email
  }
}`);
    const bridge = result.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const pullWires = bridge.wires.filter(
      (w): w is Extract<Wire, { from: any }> => "from" in w,
    );
    assert.equal(pullWires.length, 2);
    const nameWire = pullWires.find((w) => w.to.path.join(".") === "user.name");
    const emailWire = pullWires.find(
      (w) => w.to.path.join(".") === "user.email",
    );
    assert.ok(nameWire);
    assert.deepStrictEqual(nameWire.from.path, ["name"]);
    assert.ok(emailWire);
    assert.deepStrictEqual(emailWire.from.path, ["email"]);
  });

  test("nested scope blocks", () => {
    const result = parseBridge(`version 1.5

bridge Query.test {
  with input as i
  with output as o

  o.body.user {
    .profile {
      .id <- i.id
      .name <- i.name
    }
    .settings {
      .theme = "dark"
      .notifications = true
    }
  }
}`);
    const bridge = result.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const wires = bridge.wires;

    // Pull wires
    const pullWires = wires.filter(
      (w): w is Extract<Wire, { from: any }> => "from" in w,
    );
    const idWire = pullWires.find(
      (w) => w.to.path.join(".") === "body.user.profile.id",
    );
    const nameWire = pullWires.find(
      (w) => w.to.path.join(".") === "body.user.profile.name",
    );
    assert.ok(idWire, "id wire should exist");
    assert.ok(nameWire, "name wire should exist");
    assert.deepStrictEqual(idWire.from.path, ["id"]);
    assert.deepStrictEqual(nameWire.from.path, ["name"]);

    // Constant wires
    const constWires = wires.filter(
      (w): w is Extract<Wire, { value: string }> => "value" in w,
    );
    const themeWire = constWires.find(
      (w) => w.to.path.join(".") === "body.user.settings.theme",
    );
    const notifWire = constWires.find(
      (w) => w.to.path.join(".") === "body.user.settings.notifications",
    );
    assert.ok(themeWire);
    assert.equal(themeWire.value, "dark");
    assert.ok(notifWire);
    assert.equal(notifWire.value, "true");
  });

  test("scope block with pipe operator", () => {
    const result = parseBridge(`version 1.5

bridge Query.test {
  with std.str.toUpperCase as uc
  with input as i
  with output as o

  o.profile {
    .name <- uc:i.name
    .id <- i.id
  }
}`);
    const bridge = result.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    assert.ok(bridge.pipeHandles && bridge.pipeHandles.length > 0);
  });

  test("scope block with fallback operators", () => {
    const result = parseBridge(`version 1.5

bridge Query.test {
  with input as i
  with output as o

  o.data {
    .name <- i.name || "anonymous"
    .value <- i.value catch 0
  }
}`);
    const bridge = result.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const pullWires = bridge.wires.filter(
      (w): w is Extract<Wire, { from: any }> => "from" in w,
    );
    const nameWire = pullWires.find((w) => w.to.path.join(".") === "data.name");
    assert.ok(nameWire);
    assert.equal(nameWire.falsyFallback, '"anonymous"');

    const valueWire = pullWires.find(
      (w) => w.to.path.join(".") === "data.value",
    );
    assert.ok(valueWire);
    assert.equal(valueWire.catchFallback, "0");
  });

  test("scope block with expression", () => {
    const result = parseBridge(`version 1.5

bridge Query.test {
  with input as i
  with output as o

  o.pricing {
    .cents <- i.dollars * 100
    .eligible <- i.amount >= 50
  }
}`);
    const bridge = result.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    assert.ok(bridge.pipeHandles && bridge.pipeHandles.length > 0);
  });

  test("scope block with ternary", () => {
    const result = parseBridge(`version 1.5

bridge Query.test {
  with input as i
  with output as o

  o.result {
    .tier <- i.isPro ? "premium" : "basic"
    .price <- i.isPro ? i.proPrice : i.basicPrice
  }
}`);
    const bridge = result.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const ternaryWires = bridge.wires.filter((w) => "cond" in w);
    assert.equal(ternaryWires.length, 2);
  });

  test("scope block with string interpolation", () => {
    const result = parseBridge(`version 1.5

bridge Query.test {
  with input as i
  with output as o

  o.display {
    .greeting <- "Hello, {i.name}!"
    .url <- "/users/{i.id}/profile"
  }
}`);
    const bridge = result.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    assert.ok(bridge.pipeHandles && bridge.pipeHandles.length > 0);
  });

  test("mixed flat wires and scope blocks", () => {
    const result = parseBridge(`version 1.5

bridge Query.test {
  with input as i
  with output as o

  o.method = "POST"
  o.body {
    .name <- i.name
    .value = "test"
  }
  o.status = true
}`);
    const bridge = result.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const constWires = bridge.wires.filter(
      (w): w is Extract<Wire, { value: string }> => "value" in w,
    );
    assert.equal(constWires.length, 3);
    assert.ok(constWires.find((w) => w.to.path.join(".") === "method"));
    assert.ok(constWires.find((w) => w.to.path.join(".") === "body.value"));
    assert.ok(constWires.find((w) => w.to.path.join(".") === "status"));
  });

  test("scope block on tool handle", () => {
    const result = parseBridge(`version 1.5

tool api from std.httpCall {
  .baseUrl = "https://api.example.com"
  .method = POST
}

bridge Mutation.createUser {
  with api
  with input as i
  with output as o

  api.body {
    .name <- i.name
    .email <- i.email
  }
  o.success = true
}`);
    const bridge = result.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const pullWires = bridge.wires.filter(
      (w): w is Extract<Wire, { from: any }> => "from" in w,
    );
    const nameWire = pullWires.find((w) => w.to.path.join(".") === "body.name");
    const emailWire = pullWires.find(
      (w) => w.to.path.join(".") === "body.email",
    );
    assert.ok(nameWire, "name wire targeting api.body.name should exist");
    assert.ok(emailWire, "email wire targeting api.body.email should exist");
  });

  test("scope blocks produce same wires as flat syntax", () => {
    const scopedResult = parseBridge(`version 1.5

bridge Query.test {
  with input as i
  with output as o

  o.user {
    .profile {
      .id <- i.id
      .name <- i.name
    }
    .settings {
      .theme = "dark"
    }
  }
}`);

    const flatResult = parseBridge(`version 1.5

bridge Query.test {
  with input as i
  with output as o

  o.user.profile.id <- i.id
  o.user.profile.name <- i.name
  o.user.settings.theme = "dark"
}`);

    const scopedBridge = scopedResult.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const flatBridge = flatResult.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;

    assert.deepStrictEqual(scopedBridge.wires, flatBridge.wires);
  });
});

// ── Serializer round-trip tests ─────────────────────────────────────────────

describe("path scoping – serializer round-trip", () => {
  test("scoped wires round-trip through serializer as flat wires", () => {
    const input = `version 1.5

bridge Query.test {
  with input as i
  with output as o

  o.user {
    .name <- i.name
    .email <- i.email
  }
}`;
    const parsed = parseBridge(input);
    const serialized = serializeBridge(parsed);
    const reparsed = parseBridge(serialized);

    const bridge1 = parsed.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const bridge2 = reparsed.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    assert.deepStrictEqual(bridge1.wires, bridge2.wires);
  });

  test("deeply nested scope round-trips correctly", () => {
    const input = `version 1.5

bridge Query.test {
  with input as i
  with output as o

  o.body.user {
    .profile {
      .id <- i.id
      .name <- i.name
    }
    .settings {
      .theme = "dark"
    }
  }
}`;
    const parsed = parseBridge(input);
    const serialized = serializeBridge(parsed);
    const reparsed = parseBridge(serialized);

    const bridge1 = parsed.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const bridge2 = reparsed.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    assert.deepStrictEqual(bridge1.wires, bridge2.wires);
  });
});

// ── Execution tests ─────────────────────────────────────────────────────────

forEachEngine("path scoping execution", (run, _ctx) => {
  describe("basic", () => {
    test("scope block constants resolve at runtime", async () => {
      const bridge = `version 1.5

bridge Query.config {
  with output as o

  o {
    .theme = "dark"
    .lang = "en"
  }
}`;
      const result = await run(bridge, "Query.config", {});
      assert.deepStrictEqual(result.data, { theme: "dark", lang: "en" });
    });

    test("scope block pull wires resolve at runtime", async () => {
      const bridge = `version 1.5

bridge Query.user {
  with input as i
  with output as o

  o {
    .name <- i.name
    .email <- i.email
  }
}`;
      const result = await run(bridge, "Query.user", {
        name: "Alice",
        email: "alice@test.com",
      });
      assert.deepStrictEqual(result.data, {
        name: "Alice",
        email: "alice@test.com",
      });
    });

    test("nested scope blocks resolve deeply nested objects", async () => {
      const bridge = `version 1.5

bridge Query.profile {
  with input as i
  with output as o

  o.identity.id <- i.id
  o.identity.name <- i.name
  o.settings.theme <- i.theme || "light"
  o.settings.notifications = true
}`;
      // First verify this works with flat syntax
      const flatResult = await run(bridge, "Query.profile", {
        id: "42",
        name: "Bob",
        theme: "dark",
      });

      // Then verify scope block syntax produces identical result
      const scopedBridge = `version 1.5

bridge Query.profile {
  with input as i
  with output as o

  o {
    .identity {
      .id <- i.id
      .name <- i.name
    }
    .settings {
      .theme <- i.theme || "light"
      .notifications = true
    }
  }
}`;
      const scopedResult = await run(scopedBridge, "Query.profile", {
        id: "42",
        name: "Bob",
        theme: "dark",
      });

      assert.deepStrictEqual(scopedResult.data, flatResult.data);
    });

    test("scope block on tool input wires to tool correctly", () => {
      const bridge = `version 1.5

tool api from std.httpCall {
  .baseUrl = "https://nominatim.openstreetmap.org"
  .method = GET
  .path = "/search"
}

bridge Query.test {
  with api
  with input as i
  with output as o

  api {
    .q <- i.city
  }
  o.success = true
}`;
      const parsed = parseBridge(bridge);
      const br = parsed.instructions.find(
        (i): i is Bridge => i.kind === "bridge",
      )!;
      const pullWires = br.wires.filter(
        (w): w is Extract<Wire, { from: any }> => "from" in w,
      );
      const qWire = pullWires.find((w) => w.to.path.join(".") === "q");
      assert.ok(qWire, "wire to api.q should exist");
    });

    test("alias inside nested scope blocks parses correctly", () => {
      const bridge = `version 1.5

bridge Query.user {
  with std.str.toUpperCase as uc
  with input as i
  with output as o

  o {
    .info {
      alias uc:i.name as upper
      .displayName <- upper
      .email <- i.email
    }
  }
}`;
      const parsed = parseBridge(bridge);
      const br = parsed.instructions.find(
        (i): i is Bridge => i.kind === "bridge",
      )!;
      const pullWires = br.wires.filter(
        (w): w is Extract<Wire, { from: any }> => "from" in w,
      );
      // Alias creates a __local wire
      const localWire = pullWires.find(
        (w) => w.to.module === "__local" && w.to.field === "upper",
      );
      assert.ok(localWire, "alias wire to __local:Shadow:upper should exist");
      // displayName wire reads from alias
      const displayWire = pullWires.find(
        (w) => w.to.path.join(".") === "info.displayName",
      );
      assert.ok(displayWire, "wire to o.info.displayName should exist");
      assert.equal(displayWire!.from.module, "__local");
      assert.equal(displayWire!.from.field, "upper");
      // email wire reads from input
      const emailWire = pullWires.find(
        (w) => w.to.path.join(".") === "info.email",
      );
      assert.ok(emailWire, "wire to o.info.email should exist");
    });
  });
});

// ── Array mapper path scoping tests ─────────────────────────────────────────

describe("path scoping – array mapper blocks", () => {
  test("scope block with constant inside array mapper produces element wire", () => {
    const result = parseBridge(`version 1.5

bridge Query.test {
  with input as i
  with output as o

  o <- i.items[] as item {
    .obj {
      .etc = 1
    }
  }
}`);
    const bridge = result.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const constWires = bridge.wires.filter(
      (w): w is Extract<Wire, { value: string }> => "value" in w,
    );
    assert.equal(constWires.length, 1);
    const wire = constWires[0];
    assert.equal(wire.value, "1");
    assert.deepStrictEqual(wire.to.path, ["obj", "etc"]);
    assert.equal(wire.to.element, true);
  });

  test("scope block with pull wire inside array mapper references iterator", () => {
    const result = parseBridge(`version 1.5

bridge Query.test {
  with input as i
  with output as o

  o <- i.items[] as item {
    .obj {
      .name <- item.title
    }
  }
}`);
    const bridge = result.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const pullWires = bridge.wires.filter(
      (w): w is Extract<Wire, { from: any }> => "from" in w,
    );
    const nameWire = pullWires.find((w) => w.to.path.join(".") === "obj.name");
    assert.ok(nameWire, "wire to obj.name should exist");
    assert.equal(nameWire!.from.element, true);
    assert.deepStrictEqual(nameWire!.from.path, ["title"]);
  });

  test("nested scope blocks inside array mapper flatten to correct paths", () => {
    const result = parseBridge(`version 1.5

bridge Query.test {
  with input as i
  with output as o

  o <- i.items[] as item {
    .a {
      .b {
        .c = "deep"
      }
    }
  }
}`);
    const bridge = result.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const constWires = bridge.wires.filter(
      (w): w is Extract<Wire, { value: string }> => "value" in w,
    );
    assert.equal(constWires.length, 1);
    assert.deepStrictEqual(constWires[0].to.path, ["a", "b", "c"]);
    assert.equal(constWires[0].to.element, true);
  });

  test("array mapper scope block and flat element lines coexist", () => {
    const result = parseBridge(`version 1.5

bridge Query.test {
  with input as i
  with output as o

  o <- i.items[] as item {
    .flat <- item.id
    .nested {
      .x = 1
      .y <- item.val
    }
  }
}`);
    const bridge = result.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const constWires = bridge.wires.filter(
      (w): w is Extract<Wire, { value: string }> => "value" in w,
    );
    const pullWires = bridge.wires.filter(
      (w): w is Extract<Wire, { from: any }> => "from" in w,
    );
    assert.ok(
      constWires.find((w) => w.to.path.join(".") === "nested.x"),
      "nested.x constant should exist",
    );
    assert.ok(
      pullWires.find((w) => w.to.path.join(".") === "flat"),
      "flat pull wire should exist",
    );
    assert.ok(
      pullWires.find((w) => w.to.path.join(".") === "nested.y"),
      "nested.y pull wire should exist",
    );
  });
});

forEachEngine("path scoping – array mapper execution", (run, _ctx) => {
  test("array mapper scope block executes correctly", async () => {
    const bridge = `version 1.5

bridge Query.test {
  with input as i
  with output as o

  o <- i.items[] as item {
    .obj {
      .name <- item.title
      .code = 42
    }
  }
}`;
    const result = await run(bridge, "Query.test", {
      items: [{ title: "Hello" }, { title: "World" }],
    });
    assert.deepStrictEqual(result.data, [
      { obj: { name: "Hello", code: 42 } },
      { obj: { name: "World", code: 42 } },
    ]);
  });

  test("nested scope blocks inside array mapper execute correctly", async () => {
    const bridge = `version 1.5

bridge Query.test {
  with input as i
  with output as o

  o <- i.items[] as item {
    .level1 {
      .level2 {
        .name <- item.title
        .fixed = "ok"
      }
    }
  }
}`;
    const result = await run(bridge, "Query.test", {
      items: [{ title: "Alice" }, { title: "Bob" }],
    });
    assert.deepStrictEqual(result.data, [
      { level1: { level2: { name: "Alice", fixed: "ok" } } },
      { level1: { level2: { name: "Bob", fixed: "ok" } } },
    ]);
  });
});

// ── Spread in scope blocks ───────────────────────────────────────────────────

describe("path scoping – spread syntax parser", () => {
  test("spread in top-level scope block produces root pull wire", () => {
    const result = parseBridge(`version 1.5

bridge Query.test {
  with input as i
  with myTool as t
  with output as o

  t {
    ...i
  }

  o.result <- t
}`);
    const bridge = result.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const pullWires = bridge.wires.filter(
      (w): w is Extract<Wire, { from: any }> => "from" in w,
    );
    const spreadWire = pullWires.find((w) => w.to.path.length === 0);
    assert.ok(spreadWire, "spread wire targeting tool root should exist");
    assert.deepStrictEqual(spreadWire.from.path, []);
  });

  test("spread combined with constant wires in scope block", () => {
    const result = parseBridge(`version 1.5

bridge Query.test {
  with input as i
  with myTool as t
  with output as o

  t {
    ...i
    .extra = "added"
  }

  o.result <- t
}`);
    const bridge = result.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const pullWires = bridge.wires.filter(
      (w): w is Extract<Wire, { from: any }> => "from" in w,
    );
    const constWires = bridge.wires.filter(
      (w): w is Extract<Wire, { value: string }> => "value" in w,
    );
    assert.ok(
      pullWires.find((w) => w.to.path.length === 0),
      "spread wire to tool root should exist",
    );
    assert.ok(
      constWires.find((w) => w.to.path.join(".") === "extra"),
      "constant wire for .extra should exist",
    );
  });

  test("spread with sub-path source in scope block", () => {
    const result = parseBridge(`version 1.5

bridge Query.test {
  with input as i
  with myTool as t
  with output as o

  t {
    ...i.profile
  }

  o.result <- t
}`);
    const bridge = result.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const pullWires = bridge.wires.filter(
      (w): w is Extract<Wire, { from: any }> => "from" in w,
    );
    const spreadWire = pullWires.find((w) => w.to.path.length === 0);
    assert.ok(spreadWire, "spread wire should exist");
    assert.deepStrictEqual(spreadWire.from.path, ["profile"]);
  });

  test("spread in nested scope block produces wire to nested path", () => {
    const result = parseBridge(`version 1.5

bridge Query.test {
  with input as i
  with output as o

  o.wrapper {
    ...i
    .flag = "true"
  }
}`);
    const bridge = result.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const pullWires = bridge.wires.filter(
      (w): w is Extract<Wire, { from: any }> => "from" in w,
    );
    const spreadWire = pullWires.find(
      (w) => w.to.path.join(".") === "wrapper" && w.from.path.length === 0,
    );
    assert.ok(spreadWire, "spread wire to o.wrapper should exist");
  });

  test("spread in deeply nested scope block", () => {
    const result = parseBridge(`version 1.5

bridge Query.test {
  with input as i
  with myTool as t
  with output as o

  t.nested {
    ...i
  }

  o.result <- t
}`);
    const bridge = result.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const pullWires = bridge.wires.filter(
      (w): w is Extract<Wire, { from: any }> => "from" in w,
    );
    const spreadWire = pullWires.find((w) => w.to.path.join(".") === "nested");
    assert.ok(spreadWire, "spread wire to tool.nested should exist");
    assert.deepStrictEqual(spreadWire.from.path, []);
  });
});

forEachEngine("path scoping – spread execution", (run, _ctx) => {
  test("spread in scope block passes all input fields to tool", async () => {
    const bridge = `version 1.5

bridge Query.test {
  with input as i
  with myTool as t
  with output as o

  t {
    ...i
  }

  o.result <- t
}`;
    const result = await run(
      bridge,
      "Query.test",
      { name: "Alice", age: 30 },
      {
        myTool: async (input: any) => ({ received: input }),
      },
    );
    assert.deepStrictEqual(result.data, {
      result: { received: { name: "Alice", age: 30 } },
    });
  });

  test("spread combined with constant field override", async () => {
    const bridge = `version 1.5

bridge Query.test {
  with input as i
  with myTool as t
  with output as o

  t {
    ...i
    .extra = "added"
  }

  o.result <- t
}`;
    const result = await run(
      bridge,
      "Query.test",
      { name: "Alice", age: 30 },
      {
        myTool: async (input: any) => ({ received: input }),
      },
    );
    assert.deepStrictEqual(result.data, {
      result: { received: { name: "Alice", age: 30, extra: "added" } },
    });
  });

  test("spread with sub-path source", async () => {
    const bridge = `version 1.5

bridge Query.test {
  with input as i
  with myTool as t
  with output as o

  t {
    ...i.profile
  }

  o.result <- t
}`;
    const result = await run(
      bridge,
      "Query.test",
      { profile: { name: "Bob", email: "bob@test.com" } },
      {
        myTool: async (input: any) => ({ received: input }),
      },
    );
    assert.deepStrictEqual(result.data, {
      result: { received: { name: "Bob", email: "bob@test.com" } },
    });
  });
});

// ── Spread into output ────────────────────────────────────────────────────────

forEachEngine("path scoping – spread into output", (run, _ctx) => {
  test("basic spread of input into output", async () => {
    const bridge = `version 1.5

bridge Query.greet {
  with input as i
  with output as o

  o {
    ...i
  }
}`;
    const result = await run(bridge, "Query.greet", { name: "Hello Bridge" });
    assert.deepStrictEqual(result.data, { name: "Hello Bridge" });
  });

  test("spread with explicit field overrides", async () => {
    const bridge = `version 1.5

bridge Query.greet {
  with input as i
  with output as o

  o {
    ...i
    .message <- i.name
  }
}`;
    const result = await run(bridge, "Query.greet", { name: "Hello Bridge" });
    assert.deepStrictEqual(result.data, {
      name: "Hello Bridge",
      message: "Hello Bridge",
    });
  });

  test("spread with multiple sources in order", async () => {
    const bridge = `version 1.5

bridge Query.test {
  with input as i
  with output as o

  o {
    ...i.first
    ...i.second
  }
}`;
    const result = await run(bridge, "Query.test", {
      first: { a: 1, b: 2 },
      second: { b: 3, c: 4 },
    });
    // second should override b from first
    assert.deepStrictEqual(result.data, { a: 1, b: 3, c: 4 });
  });

  test("spread with explicit override taking precedence", async () => {
    const bridge = `version 1.5

bridge Query.test {
  with input as i
  with output as o

  o {
    ...i
    .name = "overridden"
  }
}`;
    const result = await run(bridge, "Query.test", {
      name: "original",
      age: 30,
    });
    // explicit .name should override spread
    assert.deepStrictEqual(result.data, { name: "overridden", age: 30 });
  });

  test("spread with deep path source", async () => {
    const bridge = `version 1.5

bridge Query.test {
  with input as i
  with output as o

  o {
    ...i.user.profile
  }
}`;
    const result = await run(bridge, "Query.test", {
      user: { profile: { email: "test@test.com", verified: true } },
    });
    assert.deepStrictEqual(result.data, {
      email: "test@test.com",
      verified: true,
    });
  });

  test("spread combined with pipe operators", async () => {
    const bridge = `version 1.5

bridge Query.greet {
  with std.str.toUpperCase as uc
  with std.str.toLowerCase as lc
  with input as i
  with output as o

  o {
    ...i
    .upper <- uc:i.name
    .lower <- lc:i.name
  }
}`;
    const result = await run(bridge, "Query.greet", { name: "Hello Bridge" });
    assert.deepStrictEqual(result.data, {
      name: "Hello Bridge",
      upper: "HELLO BRIDGE",
      lower: "hello bridge",
    });
  });

  test("spread into nested output scope", async () => {
    const bridge = `version 1.5

bridge Query.test {
  with input as i
  with output as o

  o.result {
    ...i.data
    .extra = "added"
  }
}`;
    const result = await run(bridge, "Query.test", {
      data: { x: 1, y: 2 },
    });
    assert.deepStrictEqual(result.data, {
      result: { x: 1, y: 2, extra: "added" },
    });
  });
});

// ── Null intermediate path access ────────────────────────────────────────────

forEachEngine("path traversal: null intermediate segment", (run, _ctx) => {
  test("throws TypeError when intermediate path segment is null", async () => {
    const bridgeText = `version 1.5
bridge Query.test {
  with myTool as t
  with output as o

o.result <- t.user.profile.name

}`;
    await assert.rejects(
      () =>
        run(
          bridgeText,
          "Query.test",
          {},
          {
            myTool: async () => ({ user: { profile: null } }),
          },
        ),
      /Cannot read properties of null \(reading 'name'\)/,
    );
  });
});
