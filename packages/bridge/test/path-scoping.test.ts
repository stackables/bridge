import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  parseBridge,
  serializeBridge,
} from "../src/bridge-format.ts";
import type { Bridge, Instruction, Wire } from "../src/types.ts";
import { SELF_MODULE } from "../src/types.ts";
import { executeBridge } from "../src/execute-bridge.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function run(
  bridgeText: string,
  operation: string,
  input: Record<string, unknown> = {},
) {
  const raw = parseBridge(bridgeText);
  const instructions = JSON.parse(JSON.stringify(raw)) as Instruction[];
  return executeBridge({ instructions, operation, input });
}

// ── Parser tests ────────────────────────────────────────────────────────────

describe("path scoping – parser", () => {
  test("simple scope block with constants", () => {
    const result = parseBridge(`version 1.4

bridge Query.test {
  with output as o

  o.settings {
    .theme = "dark"
    .lang = "en"
  }
}`);
    const bridge = result.find((i): i is Bridge => i.kind === "bridge")!;
    assert.ok(bridge);
    const constWires = bridge.wires.filter(
      (w): w is Extract<Wire, { value: string }> => "value" in w,
    );
    assert.equal(constWires.length, 2);
    const theme = constWires.find((w) =>
      w.to.path.join(".") === "settings.theme",
    );
    const lang = constWires.find((w) =>
      w.to.path.join(".") === "settings.lang",
    );
    assert.ok(theme);
    assert.equal(theme.value, "dark");
    assert.ok(lang);
    assert.equal(lang.value, "en");
  });

  test("scope block with pull wires", () => {
    const result = parseBridge(`version 1.4

bridge Query.test {
  with input as i
  with output as o

  o.user {
    .name <- i.name
    .email <- i.email
  }
}`);
    const bridge = result.find((i): i is Bridge => i.kind === "bridge")!;
    const pullWires = bridge.wires.filter(
      (w): w is Extract<Wire, { from: any }> => "from" in w,
    );
    assert.equal(pullWires.length, 2);
    const nameWire = pullWires.find(
      (w) => w.to.path.join(".") === "user.name",
    );
    const emailWire = pullWires.find(
      (w) => w.to.path.join(".") === "user.email",
    );
    assert.ok(nameWire);
    assert.deepStrictEqual(nameWire.from.path, ["name"]);
    assert.ok(emailWire);
    assert.deepStrictEqual(emailWire.from.path, ["email"]);
  });

  test("nested scope blocks", () => {
    const result = parseBridge(`version 1.4

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
    const bridge = result.find((i): i is Bridge => i.kind === "bridge")!;
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
    const result = parseBridge(`version 1.4

bridge Query.test {
  with std.upperCase as uc
  with input as i
  with output as o

  o.profile {
    .name <- uc:i.name
    .id <- i.id
  }
}`);
    const bridge = result.find((i): i is Bridge => i.kind === "bridge")!;
    assert.ok(bridge.pipeHandles && bridge.pipeHandles.length > 0);
  });

  test("scope block with fallback operators", () => {
    const result = parseBridge(`version 1.4

bridge Query.test {
  with input as i
  with output as o

  o.data {
    .name <- i.name || "anonymous"
    .value <- i.value ?? 0
  }
}`);
    const bridge = result.find((i): i is Bridge => i.kind === "bridge")!;
    const pullWires = bridge.wires.filter(
      (w): w is Extract<Wire, { from: any }> => "from" in w,
    );
    const nameWire = pullWires.find(
      (w) => w.to.path.join(".") === "data.name",
    );
    assert.ok(nameWire);
    assert.equal(nameWire.nullFallback, '"anonymous"');

    const valueWire = pullWires.find(
      (w) => w.to.path.join(".") === "data.value",
    );
    assert.ok(valueWire);
    assert.equal(valueWire.fallback, "0");
  });

  test("scope block with expression", () => {
    const result = parseBridge(`version 1.4

bridge Query.test {
  with input as i
  with output as o

  o.pricing {
    .cents <- i.dollars * 100
    .eligible <- i.amount >= 50
  }
}`);
    const bridge = result.find((i): i is Bridge => i.kind === "bridge")!;
    assert.ok(bridge.pipeHandles && bridge.pipeHandles.length > 0);
  });

  test("scope block with ternary", () => {
    const result = parseBridge(`version 1.4

bridge Query.test {
  with input as i
  with output as o

  o.result {
    .tier <- i.isPro ? "premium" : "basic"
    .price <- i.isPro ? i.proPrice : i.basicPrice
  }
}`);
    const bridge = result.find((i): i is Bridge => i.kind === "bridge")!;
    const ternaryWires = bridge.wires.filter((w) => "cond" in w);
    assert.equal(ternaryWires.length, 2);
  });

  test("scope block with string interpolation", () => {
    const result = parseBridge(`version 1.4

bridge Query.test {
  with input as i
  with output as o

  o.display {
    .greeting <- "Hello, {i.name}!"
    .url <- "/users/{i.id}/profile"
  }
}`);
    const bridge = result.find((i): i is Bridge => i.kind === "bridge")!;
    assert.ok(bridge.pipeHandles && bridge.pipeHandles.length > 0);
  });

  test("mixed flat wires and scope blocks", () => {
    const result = parseBridge(`version 1.4

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
    const bridge = result.find((i): i is Bridge => i.kind === "bridge")!;
    const constWires = bridge.wires.filter(
      (w): w is Extract<Wire, { value: string }> => "value" in w,
    );
    assert.equal(constWires.length, 3);
    assert.ok(constWires.find((w) => w.to.path.join(".") === "method"));
    assert.ok(constWires.find((w) => w.to.path.join(".") === "body.value"));
    assert.ok(constWires.find((w) => w.to.path.join(".") === "status"));
  });

  test("scope block on tool handle", () => {
    const result = parseBridge(`version 1.4

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
    const bridge = result.find((i): i is Bridge => i.kind === "bridge")!;
    const pullWires = bridge.wires.filter(
      (w): w is Extract<Wire, { from: any }> => "from" in w,
    );
    const nameWire = pullWires.find(
      (w) => w.to.path.join(".") === "body.name",
    );
    const emailWire = pullWires.find(
      (w) => w.to.path.join(".") === "body.email",
    );
    assert.ok(nameWire, "name wire targeting api.body.name should exist");
    assert.ok(emailWire, "email wire targeting api.body.email should exist");
  });

  test("scope blocks produce same wires as flat syntax", () => {
    const scopedResult = parseBridge(`version 1.4

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

    const flatResult = parseBridge(`version 1.4

bridge Query.test {
  with input as i
  with output as o

  o.user.profile.id <- i.id
  o.user.profile.name <- i.name
  o.user.settings.theme = "dark"
}`);

    const scopedBridge = scopedResult.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const flatBridge = flatResult.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;

    assert.deepStrictEqual(scopedBridge.wires, flatBridge.wires);
  });
});

// ── Serializer round-trip tests ─────────────────────────────────────────────

describe("path scoping – serializer round-trip", () => {
  test("scoped wires round-trip through serializer as flat wires", () => {
    const input = `version 1.4

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

    const bridge1 = parsed.find((i): i is Bridge => i.kind === "bridge")!;
    const bridge2 = reparsed.find((i): i is Bridge => i.kind === "bridge")!;
    assert.deepStrictEqual(bridge1.wires, bridge2.wires);
  });

  test("deeply nested scope round-trips correctly", () => {
    const input = `version 1.4

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

    const bridge1 = parsed.find((i): i is Bridge => i.kind === "bridge")!;
    const bridge2 = reparsed.find((i): i is Bridge => i.kind === "bridge")!;
    assert.deepStrictEqual(bridge1.wires, bridge2.wires);
  });
});

// ── Execution tests ─────────────────────────────────────────────────────────

describe("path scoping – execution", () => {
  test("scope block constants resolve at runtime", async () => {
    const bridge = `version 1.4

bridge Query.config {
  with output as o

  o {
    .theme = "dark"
    .lang = "en"
  }
}`;
    const result = await run(bridge, "Query.config");
    assert.deepStrictEqual(result.data, { theme: "dark", lang: "en" });
  });

  test("scope block pull wires resolve at runtime", async () => {
    const bridge = `version 1.4

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
    const bridge = `version 1.4

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
    const scopedBridge = `version 1.4

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
    const bridge = `version 1.4

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
    const br = parsed.find((i): i is Bridge => i.kind === "bridge")!;
    const pullWires = br.wires.filter(
      (w): w is Extract<Wire, { from: any }> => "from" in w,
    );
    const qWire = pullWires.find((w) => w.to.path.join(".") === "q");
    assert.ok(qWire, "wire to api.q should exist");
  });
});
