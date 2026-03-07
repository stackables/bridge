import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  parseBridgeFormat as parseBridge,
  serializeBridge,
} from "../src/index.ts";
import { BridgeAbortError, BridgePanicError } from "../src/index.ts";
import type { Bridge, Wire } from "../src/index.ts";
import { forEachEngine } from "./_dual-run.ts";

// ══════════════════════════════════════════════════════════════════════════════
// 1. Parser: control flow keywords
// ══════════════════════════════════════════════════════════════════════════════

describe("parseBridge: control flow keywords", () => {
  test("throw on || gate", () => {
    const doc = parseBridge(`version 1.5
bridge Query.test {
  with input as i
  with output as o
  o.name <- i.name || throw "name is required"
}`);
    const b = doc.instructions.find((i): i is Bridge => i.kind === "bridge")!;
    const pullWire = b.wires.find(
      (w): w is Extract<Wire, { from: any }> =>
        "from" in w && w.to.path.join(".") === "name",
    );
    assert.ok(pullWire);
    assert.deepStrictEqual(pullWire.fallbacks, [
      {
        type: "falsy",
        control: { kind: "throw", message: "name is required" },
      },
    ]);
  });

  test("panic on ?? gate", () => {
    const doc = parseBridge(`version 1.5
bridge Query.test {
  with input as i
  with output as o
  o.name <- i.name ?? panic "fatal: name cannot be null"
}`);
    const b = doc.instructions.find((i): i is Bridge => i.kind === "bridge")!;
    const pullWire = b.wires.find(
      (w): w is Extract<Wire, { from: any }> =>
        "from" in w && w.to.path.join(".") === "name",
    );
    assert.ok(pullWire);
    assert.deepStrictEqual(pullWire.fallbacks, [
      {
        type: "nullish",
        control: { kind: "panic", message: "fatal: name cannot be null" },
      },
    ]);
  });

  test("continue on ?? gate", () => {
    const doc = parseBridge(`version 1.5
bridge Query.test {
  with api as a
  with input as i
  with output as o
  o.items <- a.list[] as item {
    .name <- item.name ?? continue
  }
}`);
    const b = doc.instructions.find((i): i is Bridge => i.kind === "bridge")!;
    const elemWire = b.wires.find(
      (w): w is Extract<Wire, { from: any }> =>
        "from" in w &&
        w.from.element === true &&
        w.to.path.join(".") === "items.name",
    );
    assert.ok(elemWire);
    assert.deepStrictEqual(elemWire.fallbacks, [
      { type: "nullish", control: { kind: "continue" } },
    ]);
  });

  test("break on ?? gate", () => {
    const doc = parseBridge(`version 1.5
bridge Query.test {
  with api as a
  with input as i
  with output as o
  o.items <- a.list[] as item {
    .name <- item.name ?? break
  }
}`);
    const b = doc.instructions.find((i): i is Bridge => i.kind === "bridge")!;
    const elemWire = b.wires.find(
      (w): w is Extract<Wire, { from: any }> =>
        "from" in w &&
        w.from.element === true &&
        w.to.path.join(".") === "items.name",
    );
    assert.ok(elemWire);
    assert.deepStrictEqual(elemWire.fallbacks, [
      { type: "nullish", control: { kind: "break" } },
    ]);
  });

  test("break/continue with levels on ?? gate", () => {
    const doc = parseBridge(`version 1.5
bridge Query.test {
  with api as a
  with output as o
  o <- a.orders[] as order {
    .items <- order.items[] as item {
      .sku <- item.sku ?? continue 2
      .price <- item.price ?? break 2
    }
  }
}`);
    const b = doc.instructions.find((i): i is Bridge => i.kind === "bridge")!;
    const skuWire = b.wires.find(
      (w): w is Extract<Wire, { from: any }> =>
        "from" in w &&
        w.from.element === true &&
        w.to.path.join(".") === "items.sku",
    );
    const priceWire = b.wires.find(
      (w): w is Extract<Wire, { from: any }> =>
        "from" in w &&
        w.from.element === true &&
        w.to.path.join(".") === "items.price",
    );
    assert.ok(skuWire);
    assert.ok(priceWire);
    assert.deepStrictEqual(skuWire.fallbacks, [
      { type: "nullish", control: { kind: "continue", levels: 2 } },
    ]);
    assert.deepStrictEqual(priceWire.fallbacks, [
      { type: "nullish", control: { kind: "break", levels: 2 } },
    ]);
  });

  test("throw on catch gate", () => {
    const doc = parseBridge(`version 1.5
bridge Query.test {
  with api as a
  with input as i
  with output as o
  o.name <- a.name catch throw "api failed"
}`);
    const b = doc.instructions.find((i): i is Bridge => i.kind === "bridge")!;
    const pullWire = b.wires.find(
      (w): w is Extract<Wire, { from: any }> =>
        "from" in w && w.to.path.join(".") === "name",
    );
    assert.ok(pullWire);
    assert.deepStrictEqual(pullWire.catchControl, {
      kind: "throw",
      message: "api failed",
    });
  });

  test("panic on catch gate", () => {
    const doc = parseBridge(`version 1.5
bridge Query.test {
  with api as a
  with input as i
  with output as o
  o.name <- a.name catch panic "unrecoverable"
}`);
    const b = doc.instructions.find((i): i is Bridge => i.kind === "bridge")!;
    const pullWire = b.wires.find(
      (w): w is Extract<Wire, { from: any }> =>
        "from" in w && w.to.path.join(".") === "name",
    );
    assert.ok(pullWire);
    assert.deepStrictEqual(pullWire.catchControl, {
      kind: "panic",
      message: "unrecoverable",
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. Serializer: roundtrip
// ══════════════════════════════════════════════════════════════════════════════

describe("serializeBridge: control flow roundtrip", () => {
  test("throw on || gate round-trips", () => {
    const src = `version 1.5

bridge Query.test {
  with input as i
  with output as o
  o.name <- i.name || throw "name is required"
}`;
    const doc = parseBridge(src);
    const out = serializeBridge(doc);
    assert.ok(out.includes('|| throw "name is required"'));
    // Parse again and compare AST
    const roundtripped = parseBridge(out);
    const b = roundtripped.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const pullWire = b.wires.find(
      (w): w is Extract<Wire, { from: any }> =>
        "from" in w && w.to.path.join(".") === "name",
    );
    assert.ok(pullWire);
    assert.deepStrictEqual(pullWire.fallbacks, [
      {
        type: "falsy",
        control: { kind: "throw", message: "name is required" },
      },
    ]);
  });

  test("panic on ?? gate round-trips", () => {
    const src = `version 1.5

bridge Query.test {
  with input as i
  with output as o
  o.name <- i.name ?? panic "fatal"
}`;
    const doc = parseBridge(src);
    const out = serializeBridge(doc);
    assert.ok(out.includes('?? panic "fatal"'));
    const roundtripped = parseBridge(out);
    const b = roundtripped.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const pullWire = b.wires.find(
      (w): w is Extract<Wire, { from: any }> =>
        "from" in w && w.to.path.join(".") === "name",
    );
    assert.ok(pullWire);
    assert.deepStrictEqual(pullWire.fallbacks, [
      {
        type: "nullish",
        control: { kind: "panic", message: "fatal" },
      },
    ]);
  });

  test("continue on ?? gate round-trips", () => {
    const src = `version 1.5

bridge Query.test {
  with api as a
  with input as i
  with output as o
  o.items <- a.list[] as item {
    .name <- item.name ?? continue
  }
}`;
    const doc = parseBridge(src);
    const out = serializeBridge(doc);
    assert.ok(out.includes("?? continue"));
    const roundtripped = parseBridge(out);
    const b = roundtripped.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const elemWire = b.wires.find(
      (w): w is Extract<Wire, { from: any }> =>
        "from" in w &&
        w.from.element === true &&
        w.to.path.join(".") === "items.name",
    );
    assert.ok(elemWire);
    assert.deepStrictEqual(elemWire.fallbacks, [
      { type: "nullish", control: { kind: "continue" } },
    ]);
  });

  test("break on catch gate round-trips", () => {
    const src = `version 1.5

bridge Query.test {
  with api as a
  with input as i
  with output as o
  o.name <- a.name catch break
}`;
    const doc = parseBridge(src);
    const out = serializeBridge(doc);
    assert.ok(out.includes("catch break"));
    const roundtripped = parseBridge(out);
    const b = roundtripped.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const pullWire = b.wires.find(
      (w): w is Extract<Wire, { from: any }> =>
        "from" in w && w.to.path.join(".") === "name",
    );
    assert.ok(pullWire);
    assert.deepStrictEqual(pullWire.catchControl, { kind: "break" });
  });

  test("break/continue levels round-trip", () => {
    const src = `version 1.5

bridge Query.test {
  with api as a
  with output as o
  o <- a.orders[] as order {
    .items <- order.items[] as item {
      .sku <- item.sku ?? continue 2
      .price <- item.price ?? break 2
    }
  }
}`;
    const doc = parseBridge(src);
    const out = serializeBridge(doc);
    assert.ok(out.includes("?? continue 2"));
    assert.ok(out.includes("?? break 2"));
    const roundtripped = parseBridge(out);
    const b = roundtripped.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const skuWire = b.wires.find(
      (w): w is Extract<Wire, { from: any }> =>
        "from" in w &&
        w.from.element === true &&
        w.to.path.join(".") === "items.sku",
    );
    const priceWire = b.wires.find(
      (w): w is Extract<Wire, { from: any }> =>
        "from" in w &&
        w.from.element === true &&
        w.to.path.join(".") === "items.price",
    );
    assert.ok(skuWire);
    assert.ok(priceWire);
    assert.deepStrictEqual(skuWire.fallbacks, [
      { type: "nullish", control: { kind: "continue", levels: 2 } },
    ]);
    assert.deepStrictEqual(priceWire.fallbacks, [
      { type: "nullish", control: { kind: "break", levels: 2 } },
    ]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3–6. Engine execution tests (run against both engines)
// ══════════════════════════════════════════════════════════════════════════════

forEachEngine("control flow execution", (run, _ctx) => {
  describe("throw", () => {
    test("throw on || gate raises Error when value is falsy", async () => {
      const src = `version 1.5
bridge Query.test {
  with input as i
  with output as o
  o.name <- i.name || throw "name is required"
}`;
      await assert.rejects(
        () => run(src, "Query.test", { name: "" }),
        (err: Error) => {
          assert.equal(err.message, "name is required");
          return true;
        },
      );
    });

    test("throw on || gate does NOT fire when value is truthy", async () => {
      const src = `version 1.5
bridge Query.test {
  with input as i
  with output as o
  o.name <- i.name || throw "name is required"
}`;
      const { data } = await run(src, "Query.test", { name: "Alice" });
      assert.deepStrictEqual(data, { name: "Alice" });
    });

    test("throw on ?? gate raises Error when value is null", async () => {
      const src = `version 1.5
bridge Query.test {
  with input as i
  with output as o
  o.name <- i.name ?? throw "name cannot be null"
}`;
      await assert.rejects(
        () => run(src, "Query.test", {}),
        (err: Error) => {
          assert.equal(err.message, "name cannot be null");
          return true;
        },
      );
    });

    test("throw on catch gate raises Error when source throws", async () => {
      const src = `version 1.5
bridge Query.test {
  with api as a
  with output as o
  o.name <- a.name catch throw "api call failed"
}`;
      const tools = {
        api: async () => {
          throw new Error("network error");
        },
      };
      await assert.rejects(
        () => run(src, "Query.test", {}, tools),
        (err: Error) => {
          assert.equal(err.message, "api call failed");
          return true;
        },
      );
    });
  });

  describe("panic", () => {
    test("panic raises BridgePanicError", async () => {
      const src = `version 1.5
bridge Query.test {
  with input as i
  with output as o
  o.name <- i.name ?? panic "fatal error"
}`;
      await assert.rejects(
        () => run(src, "Query.test", {}),
        (err: Error) => {
          assert.ok(err instanceof BridgePanicError);
          assert.equal(err.message, "fatal error");
          return true;
        },
      );
    });

    test("panic bypasses catch gate", async () => {
      const src = `version 1.5
bridge Query.test {
  with api as a
  with output as o
  o.name <- a.name ?? panic "fatal" catch "fallback"
}`;
      const tools = {
        api: async () => ({ name: null }),
      };
      await assert.rejects(
        () => run(src, "Query.test", {}, tools),
        (err: Error) => {
          assert.ok(err instanceof BridgePanicError);
          assert.equal(err.message, "fatal");
          return true;
        },
      );
    });

    test("panic bypasses safe navigation (?.)", async () => {
      const src = `version 1.5
bridge Query.test {
  with api as a
  with output as o
  o.name <- a?.name ?? panic "must not be null"
}`;
      const tools = {
        api: async () => ({ name: null }),
      };
      await assert.rejects(
        () => run(src, "Query.test", {}, tools),
        (err: Error) => {
          assert.ok(err instanceof BridgePanicError);
          assert.equal(err.message, "must not be null");
          return true;
        },
      );
    });
  });

  describe("continue/break in arrays", () => {
    test("continue skips null elements in array mapping", async () => {
      const src = `version 1.5
bridge Query.test {
  with api as a
  with output as o
  o <- a.items[] as item {
    .name <- item.name ?? continue
  }
}`;
      const tools = {
        api: async () => ({
          items: [
            { name: "Alice" },
            { name: null },
            { name: "Bob" },
            { name: null },
          ],
        }),
      };
      const { data } = (await run(src, "Query.test", {}, tools)) as {
        data: any[];
      };
      assert.equal(data.length, 2);
      assert.deepStrictEqual(data, [{ name: "Alice" }, { name: "Bob" }]);
    });

    test("break halts array processing", async () => {
      const src = `version 1.5
bridge Query.test {
  with api as a
  with output as o
  o <- a.items[] as item {
    .name <- item.name ?? break
  }
}`;
      const tools = {
        api: async () => ({
          items: [
            { name: "Alice" },
            { name: "Bob" },
            { name: null },
            { name: "Carol" },
          ],
        }),
      };
      const { data } = (await run(src, "Query.test", {}, tools)) as {
        data: any[];
      };
      assert.equal(data.length, 2);
      assert.deepStrictEqual(data, [{ name: "Alice" }, { name: "Bob" }]);
    });

    test("?? continue on root array wire returns [] when source is null", async () => {
      // Guards against a crash where pullOutputField / response() would throw
      // TypeError: items is not iterable when resolveWires returns CONTINUE_SYM
      // for the root array wire itself.
      const src = `version 1.5
bridge Query.test {
  with api as a
  with output as o
  o <- a.items[] as item {
    .name <- item.name
  } ?? continue
}`;
      const tools = {
        api: async () => ({ items: null }),
      };
      const { data } = (await run(src, "Query.test", {}, tools)) as {
        data: any[];
      };
      assert.deepStrictEqual(data, []);
    });

    test("catch continue on root array wire returns [] when source throws", async () => {
      const src = `version 1.5
bridge Query.test {
  with api as a
  with output as o
  o <- a.items[] as item {
    .name <- item.name
  } catch continue
}`;
      const tools = {
        api: async () => {
          throw new Error("service unavailable");
        },
      };
      const { data } = (await run(src, "Query.test", {}, tools)) as {
        data: any[];
      };
      assert.deepStrictEqual(data, []);
    });

    test("continue 2 skips current parent element", async () => {
      const src = `version 1.5
bridge Query.test {
  with api as a
  with output as o
  o <- a.orders[] as order {
    .id <- order.id
    .items <- order.items[] as item {
      .sku <- item.sku ?? continue 2
      .price <- item.price
    }
  }
}`;
      const tools = {
        api: async () => ({
          orders: [
            {
              id: 1,
              items: [
                { sku: "A", price: 10 },
                { sku: null, price: 99 },
              ],
            },
            { id: 2, items: [{ sku: "B", price: 20 }] },
          ],
        }),
      };
      const { data } = (await run(src, "Query.test", {}, tools)) as {
        data: any[];
      };
      assert.deepStrictEqual(data, [
        { id: 2, items: [{ sku: "B", price: 20 }] },
      ]);
    });

    test("break 2 breaks out of parent loop", async () => {
      const src = `version 1.5
bridge Query.test {
  with api as a
  with output as o
  o <- a.orders[] as order {
    .id <- order.id
    .items <- order.items[] as item {
      .sku <- item.sku
      .price <- item.price ?? break 2
    }
  }
}`;
      const tools = {
        api: async () => ({
          orders: [
            { id: 1, items: [{ sku: "A", price: 10 }] },
            {
              id: 2,
              items: [
                { sku: "B", price: null },
                { sku: "C", price: 30 },
              ],
            },
            { id: 3, items: [{ sku: "D", price: 40 }] },
          ],
        }),
      };
      const { data } = (await run(src, "Query.test", {}, tools)) as {
        data: any[];
      };
      assert.deepStrictEqual(data, [
        { id: 1, items: [{ sku: "A", price: 10 }] },
      ]);
    });
  });

  describe("AbortSignal", () => {
    test("aborted signal prevents tool execution", async () => {
      const src = `version 1.5
bridge Query.test {
  with api as a
  with output as o
  o.name <- a.name
}`;
      const controller = new AbortController();
      controller.abort(); // Abort immediately
      const tools = {
        api: async () => {
          throw new Error("should not be called");
        },
      };
      await assert.rejects(
        () => run(src, "Query.test", {}, tools, { signal: controller.signal }),
        (err: Error) => {
          assert.ok(err instanceof BridgeAbortError);
          return true;
        },
      );
    });

    test("abort error bypasses catch gate", async () => {
      const src = `version 1.5
bridge Query.test {
  with api as a
  with output as o
  o.name <- a.name catch "fallback"
}`;
      const controller = new AbortController();
      controller.abort();
      const tools = {
        api: async () => ({ name: "test" }),
      };
      await assert.rejects(
        () => run(src, "Query.test", {}, tools, { signal: controller.signal }),
        (err: Error) => {
          assert.ok(err instanceof BridgeAbortError);
          return true;
        },
      );
    });

    test("abort error bypasses safe navigation (?.)", async () => {
      const src = `version 1.5
bridge Query.test {
  with api as a
  with output as o
  o.name <- a?.name
}`;
      const controller = new AbortController();
      controller.abort();
      const tools = {
        api: async () => ({ name: "test" }),
      };
      await assert.rejects(
        () => run(src, "Query.test", {}, tools, { signal: controller.signal }),
        (err: Error) => {
          assert.ok(err instanceof BridgeAbortError);
          return true;
        },
      );
    });

    test("signal is passed to tool context", async () => {
      const src = `version 1.5
bridge Query.test {
  with api as a
  with output as o
  o.name <- a.name
}`;
      const controller = new AbortController();
      let receivedSignal: AbortSignal | undefined;
      const tools = {
        api: async (_input: any, ctx: any) => {
          receivedSignal = ctx.signal;
          return { name: "test" };
        },
      };
      await run(src, "Query.test", {}, tools, { signal: controller.signal });
      assert.ok(receivedSignal);
      assert.equal(receivedSignal, controller.signal);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 7. Error class identity
// ══════════════════════════════════════════════════════════════════════════════

describe("BridgePanicError / BridgeAbortError", () => {
  test("BridgePanicError extends Error", () => {
    const err = new BridgePanicError("test");
    assert.ok(err instanceof Error);
    assert.ok(err instanceof BridgePanicError);
    assert.equal(err.name, "BridgePanicError");
    assert.equal(err.message, "test");
  });

  test("BridgeAbortError extends Error with default message", () => {
    const err = new BridgeAbortError();
    assert.ok(err instanceof Error);
    assert.ok(err instanceof BridgeAbortError);
    assert.equal(err.name, "BridgeAbortError");
    assert.equal(err.message, "Execution aborted by external signal");
  });

  test("BridgeAbortError accepts custom message", () => {
    const err = new BridgeAbortError("custom");
    assert.equal(err.message, "custom");
  });
});
