import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  parseBridgeFormat as parseBridge,
  serializeBridge,
} from "../src/index.ts";
import { BridgePanicError } from "../src/index.ts";
import { forEachEngine } from "./utils/dual-run.ts";
import { assertDeepStrictEqualIgnoringLoc } from "./utils/parse-test-utils.ts";

// ── Parser / desugaring tests ─────────────────────────────────────────────

describe("ternary: parser", () => {
  test("simple ref ? ref : ref produces a conditional wire", () => {
    const doc = parseBridge(`version 1.5
bridge Query.pricing {
  with input as i
  with output as o

  o.amount <- i.isPro ? i.proPrice : i.basicPrice
}`);
    const bridge = doc.instructions.find((inst) => inst.kind === "bridge")!;
    const condWire = bridge.wires.find((w) => "cond" in w);
    assert.ok(condWire, "should have a conditional wire");
    assert.ok("cond" in condWire);
    assert.ok(condWire.thenRef, "thenRef should be a NodeRef");
    assert.ok(condWire.elseRef, "elseRef should be a NodeRef");
    assert.deepEqual(condWire.thenRef!.path, ["proPrice"]);
    assert.deepEqual(condWire.elseRef!.path, ["basicPrice"]);
  });

  test("string literal branches produce thenValue / elseValue", () => {
    const doc = parseBridge(`version 1.5
bridge Query.label {
  with input as i
  with output as o

  o.tier <- i.isPro ? "premium" : "basic"
}`);
    const bridge = doc.instructions.find((inst) => inst.kind === "bridge")!;
    const condWire = bridge.wires.find((w) => "cond" in w);
    assert.ok(condWire && "cond" in condWire);
    assert.equal(condWire.thenValue, '"premium"');
    assert.equal(condWire.elseValue, '"basic"');
  });

  test("numeric literal branches produce thenValue / elseValue", () => {
    const doc = parseBridge(`version 1.5
bridge Query.pricing {
  with input as i
  with output as o

  o.discount <- i.isPro ? 20 : 0
}`);
    const bridge = doc.instructions.find((inst) => inst.kind === "bridge")!;
    const condWire = bridge.wires.find((w) => "cond" in w);
    assert.ok(condWire && "cond" in condWire);
    assert.equal(condWire.thenValue, "20");
    assert.equal(condWire.elseValue, "0");
  });

  test("boolean literal branches", () => {
    const doc = parseBridge(`version 1.5
bridge Query.check {
  with input as i
  with output as o

  o.result <- i.cond ? true : false
}`);
    const bridge = doc.instructions.find((inst) => inst.kind === "bridge")!;
    const condWire = bridge.wires.find((w) => "cond" in w);
    assert.ok(condWire && "cond" in condWire);
    assert.equal(condWire.thenValue, "true");
    assert.equal(condWire.elseValue, "false");
  });

  test("null literal branch", () => {
    const doc = parseBridge(`version 1.5
bridge Query.check {
  with input as i
  with output as o

  o.result <- i.cond ? i.value : null
}`);
    const bridge = doc.instructions.find((inst) => inst.kind === "bridge")!;
    const condWire = bridge.wires.find((w) => "cond" in w);
    assert.ok(condWire && "cond" in condWire);
    assert.ok(condWire.thenRef, "thenRef should be NodeRef");
    assert.equal(condWire.elseValue, "null");
  });

  test("condition with expression chain: i.age >= 18 ? a : b", () => {
    const doc = parseBridge(`version 1.5
bridge Query.check {
  with input as i
  with output as o

  o.result <- i.age >= 18 ? i.proValue : i.basicValue
}`);
    const bridge = doc.instructions.find((inst) => inst.kind === "bridge")!;
    const condWire = bridge.wires.find((w) => "cond" in w);
    assert.ok(condWire && "cond" in condWire);
    assert.ok(
      condWire.cond.instance != null && condWire.cond.instance >= 100000,
      "cond should be an expression fork result",
    );
    const exprHandle = bridge.pipeHandles!.find((ph) =>
      ph.handle.startsWith("__expr_"),
    );
    assert.ok(exprHandle, "should have expression fork");
    assert.equal(exprHandle.baseTrunk.field, "gte");
  });

  test("|| literal fallback stored on conditional wire", () => {
    const doc = parseBridge(`version 1.5
bridge Query.pricing {
  with input as i
  with output as o

  o.amount <- i.isPro ? i.proPrice : i.basicPrice || 0
}`);
    const bridge = doc.instructions.find((inst) => inst.kind === "bridge")!;
    const condWire = bridge.wires.find((w) => "cond" in w);
    assert.ok(condWire && "cond" in condWire);
    assertDeepStrictEqualIgnoringLoc(condWire.fallbacks, [
      { type: "falsy", value: "0" },
    ]);
  });

  test("catch literal fallback stored on conditional wire", () => {
    const doc = parseBridge(`version 1.5
bridge Query.pricing {
  with input as i
  with output as o

  o.amount <- i.isPro ? i.proPrice : i.basicPrice catch -1
}`);
    const bridge = doc.instructions.find((inst) => inst.kind === "bridge")!;
    const condWire = bridge.wires.find((w) => "cond" in w);
    assert.ok(condWire && "cond" in condWire);
    assert.equal(condWire.catchFallback, "-1");
  });
});

// ── Round-trip serialization tests ───────────────────────────────────────

describe("ternary: round-trip serialization", () => {
  test("simple ref ternary round-trips", () => {
    const text = `version 1.5
bridge Query.pricing {
  with input as i
  with output as o

  o.amount <- i.isPro ? i.proPrice : i.basicPrice
}`;
    const doc = parseBridge(text);
    const serialized = serializeBridge(doc);
    assert.ok(
      serialized.includes("? i.proPrice : i.basicPrice"),
      `got: ${serialized}`,
    );
    const reparsed = parseBridge(serialized);
    const bridge = reparsed.instructions.find(
      (inst) => inst.kind === "bridge",
    )!;
    const condWire = bridge.wires.find((w) => "cond" in w);
    assert.ok(condWire, "re-parsed should have conditional wire");
  });

  test("string literal ternary round-trips", () => {
    const text = `version 1.5
bridge Query.label {
  with input as i
  with output as o

  o.tier <- i.isPro ? "premium" : "basic"
}`;
    const doc = parseBridge(text);
    const serialized = serializeBridge(doc);
    assert.ok(
      serialized.includes(`? "premium" : "basic"`),
      `got: ${serialized}`,
    );
    const reparsed = parseBridge(serialized);
    const bridge = reparsed.instructions.find(
      (inst) => inst.kind === "bridge",
    )!;
    const condWire = bridge.wires.find((w) => "cond" in w);
    assert.ok(condWire && "cond" in condWire);
    assert.equal(condWire.thenValue, '"premium"');
  });

  test("expression condition ternary round-trips", () => {
    const text = `version 1.5
bridge Query.check {
  with input as i
  with output as o

  o.result <- i.age >= 18 ? i.proValue : i.basicValue
}`;
    const doc = parseBridge(text);
    const serialized = serializeBridge(doc);
    assert.ok(
      serialized.includes("i.age >= 18 ? i.proValue : i.basicValue"),
      `got: ${serialized}`,
    );
  });

  test("|| literal fallback round-trips", () => {
    const text = `version 1.5
bridge Query.pricing {
  with input as i
  with output as o

  o.amount <- i.isPro ? i.proPrice : i.basicPrice || 0
}`;
    const doc = parseBridge(text);
    const serialized = serializeBridge(doc);
    assert.ok(
      serialized.includes("? i.proPrice : i.basicPrice || 0"),
      `got: ${serialized}`,
    );
  });

  test("catch literal fallback round-trips", () => {
    const text = `version 1.5
bridge Query.pricing {
  with input as i
  with output as o

  o.amount <- i.isPro ? i.proPrice : i.basicPrice catch -1
}`;
    const doc = parseBridge(text);
    const serialized = serializeBridge(doc);
    assert.ok(
      serialized.includes("? i.proPrice : i.basicPrice catch -1"),
      `got: ${serialized}`,
    );
  });
});

// ── Execution tests ───────────────────────────────────────────────────────

// ── Execution tests ───────────────────────────────────────────────────────────

forEachEngine("ternary execution", (run, _ctx) => {
  describe("truthy condition", () => {
    test("selects then branch when condition is truthy", async () => {
      const { data } = await run(
        `version 1.5
bridge Query.pricing {
  with input as i
  with output as o
  o.amount <- i.isPro ? i.proPrice : i.basicPrice
}`,
        "Query.pricing",
        { isPro: true, proPrice: 99.99, basicPrice: 9.99 },
      );
      assert.equal((data as any).amount, 99.99);
    });

    test("selects else branch when condition is falsy", async () => {
      const { data } = await run(
        `version 1.5
bridge Query.pricing {
  with input as i
  with output as o
  o.amount <- i.isPro ? i.proPrice : i.basicPrice
}`,
        "Query.pricing",
        { isPro: false, proPrice: 99.99, basicPrice: 9.99 },
      );
      assert.equal((data as any).amount, 9.99);
    });
  });

  describe("literal branches", () => {
    test("string literal then branch", async () => {
      const bridge = `version 1.5
bridge Query.label {
  with input as i
  with output as o
  o.tier <- i.isPro ? "premium" : "basic"
}`;
      const pro = await run(bridge, "Query.label", { isPro: true });
      assert.equal((pro.data as any).tier, "premium");

      const basic = await run(bridge, "Query.label", { isPro: false });
      assert.equal((basic.data as any).tier, "basic");
    });

    test("numeric literal branches", async () => {
      const bridge = `version 1.5
bridge Query.pricing {
  with input as i
  with output as o
  o.discount <- i.isPro ? 20 : 0
}`;
      const pro = await run(bridge, "Query.pricing", { isPro: true });
      assert.equal((pro.data as any).discount, 20);

      const basic = await run(bridge, "Query.pricing", { isPro: false });
      assert.equal((basic.data as any).discount, 0);
    });
  });

  describe("expression condition", () => {
    test("i.age >= 18 selects then branch for adult", async () => {
      const bridge = `version 1.5
bridge Query.check {
  with input as i
  with output as o
  o.result <- i.age >= 18 ? i.proPrice : i.basicPrice
}`;
      const adult = await run(bridge, "Query.check", {
        age: 20,
        proPrice: 99,
        basicPrice: 9,
      });
      assert.equal((adult.data as any).result, 99);

      const minor = await run(bridge, "Query.check", {
        age: 15,
        proPrice: 99,
        basicPrice: 9,
      });
      assert.equal((minor.data as any).result, 9);
    });
  });

  describe("fallbacks", () => {
    test("|| literal fallback fires when chosen branch is null", async () => {
      const bridge = `version 1.5
bridge Query.pricing {
  with input as i
  with output as o
  o.amount <- i.isPro ? i.proPrice : i.basicPrice || 0
}`;
      // basicPrice is absent (null/undefined) → fallback 0
      const { data } = await run(bridge, "Query.pricing", {
        isPro: false,
        proPrice: 99,
      });
      assert.equal((data as any).amount, 0);
    });

    test("catch literal fallback fires when chosen branch throws", async () => {
      const bridge = `version 1.5
bridge Query.pricing {
  with pro.getPrice as proTool
  with input as i
  with output as o
  o.amount <- i.isPro ? proTool.price : i.basicPrice catch -1
}`;
      const tools = {
        "pro.getPrice": async () => {
          throw new Error("api down");
        },
      };
      const { data } = await run(
        bridge,
        "Query.pricing",
        { isPro: true, basicPrice: 9 },
        tools,
      );
      assert.equal((data as any).amount, -1);
    });

    test("|| sourceRef fallback fires when chosen branch is null", async () => {
      const bridge = `version 1.5
bridge Query.pricing {
  with fallback.getPrice as fb
  with input as i
  with output as o
  o.amount <- i.isPro ? i.proPrice : i.basicPrice || fb.defaultPrice
}`;
      const tools = { "fallback.getPrice": async () => ({ defaultPrice: 5 }) };
      // basicPrice absent → chosen branch null → fallback tool fires
      const { data } = await run(
        bridge,
        "Query.pricing",
        { isPro: false, proPrice: 99 },
        tools,
      );
      assert.equal((data as any).amount, 5);
    });
  });

  describe("tool branches (lazy evaluation)", () => {
    test("only the chosen branch tool is called", async () => {
      let proCalls = 0;
      let basicCalls = 0;

      const bridge = `version 1.5
bridge Query.smartPrice {
  with pro.getPrice as proTool
  with basic.getPrice as basicTool
  with input as i
  with output as o
  o.price <- i.isPro ? proTool.price : basicTool.price
}`;
      const tools = {
        "pro.getPrice": async () => {
          proCalls++;
          return { price: 99.99 };
        },
        "basic.getPrice": async () => {
          basicCalls++;
          return { price: 9.99 };
        },
      };

      // When isPro=true: only proTool should be called
      const pro = await run(bridge, "Query.smartPrice", { isPro: true }, tools);
      assert.equal((pro.data as any).price, 99.99);
      assert.equal(proCalls, 1, "proTool called once");
      assert.equal(basicCalls, 0, "basicTool not called");

      // When isPro=false: only basicTool should be called
      const basic = await run(
        bridge,
        "Query.smartPrice",
        { isPro: false },
        tools,
      );
      assert.equal((basic.data as any).price, 9.99);
      assert.equal(proCalls, 1, "proTool still called only once");
      assert.equal(basicCalls, 1, "basicTool called once");
    });
  });

  describe("in array mapping", () => {
    test("ternary works inside array element mapping", async () => {
      const bridge = `version 1.5
bridge Query.products {
  with catalog.list as api
  with output as o
  o <- api.items[] as item {
    .name <- item.name
    .price <- item.isPro ? item.proPrice : item.basicPrice
  }
}`;
      const tools = {
        "catalog.list": async () => ({
          items: [
            { name: "Widget", isPro: true, proPrice: 99, basicPrice: 9 },
            { name: "Gadget", isPro: false, proPrice: 199, basicPrice: 19 },
          ],
        }),
      };
      const { data } = await run(bridge, "Query.products", {}, tools);
      const products = data as any[];
      assert.equal(products[0].name, "Widget");
      assert.equal(products[0].price, 99, "isPro=true → proPrice");
      assert.equal(products[1].name, "Gadget");
      assert.equal(products[1].price, 19, "isPro=false → basicPrice");
    });
  });

  describe("alias + fallback modifiers (Lazy Gate)", () => {
    test("alias ternary + ?? panic fires on false branch → null", async () => {
      const src = `version 1.5
bridge Query.location {
  with geoApi as geo
  with input as i
  with output as o

  alias (i.age >= 18) ? i : null ?? panic "Must be 18 or older" as ageChecked

  geo.q <- ageChecked?.city

  o.lat <- geo[0].lat
  o.lon <- geo[0].lon
}`;
      const tools = {
        geoApi: async () => [{ lat: 47.37, lon: 8.54 }],
      };
      await assert.rejects(
        () => run(src, "Query.location", { age: 15, city: "Zurich" }, tools),
        (err: Error) => {
          assert.ok(err instanceof BridgePanicError);
          assert.equal(err.message, "Must be 18 or older");
          return true;
        },
      );
    });

    test("alias ternary + ?? panic does NOT fire when condition is true", async () => {
      const src = `version 1.5
bridge Query.location {
  with geoApi as geo
  with input as i
  with output as o

  alias (i.age >= 18) ? i : null ?? panic "Must be 18 or older" as ageChecked

  geo.q <- ageChecked?.city

  o.lat <- geo[0].lat
  o.lon <- geo[0].lon
}`;
      const tools = {
        geoApi: async () => [{ lat: 47.37, lon: 8.54 }],
      };
      const { data } = await run(
        src,
        "Query.location",
        { age: 25, city: "Zurich" },
        tools,
      );
      assert.equal((data as any).lat, 47.37);
      assert.equal((data as any).lon, 8.54);
    });

    test("alias ternary + || literal fallback", async () => {
      const src = `version 1.5
bridge Query.test {
  with input as i
  with output as o
  alias i.score >= 50 ? i.grade : null || "F" as grade
  o.grade <- grade
}`;
      const { data } = await run(src, "Query.test", { score: 30 });
      assert.equal((data as any).grade, "F");
    });

    test("alias ternary + || ref fallback", async () => {
      const src = `version 1.5
bridge Query.test {
  with fallback.api as fb
  with input as i
  with output as o
  alias i.score >= 50 ? i.grade : null || fb.grade as grade
  o.grade <- grade
}`;
      const tools = {
        "fallback.api": async () => ({ grade: "F" }),
      };
      const { data } = await run(src, "Query.test", { score: 30 }, tools);
      assert.equal((data as any).grade, "F");
    });

    test("alias ternary + catch literal fallback", async () => {
      const src = `version 1.5
bridge Query.test {
  with api as a
  with output as o
  alias a.ok ? a.value : a.alt catch "safe" as result
  o.val <- result
}`;
      const tools = {
        api: async () => {
          throw new Error("boom");
        },
      };
      const { data } = await run(src, "Query.test", {}, tools);
      assert.equal((data as any).val, "safe");
    });

    test("string alias ternary + ?? panic", async () => {
      const src = `version 1.5
bridge Query.test {
  with input as i
  with output as o
  alias "hello" == i.secret ? "access granted" : null ?? panic "wrong secret" as result
  o.msg <- result
}`;
      await assert.rejects(
        () => run(src, "Query.test", { secret: "world" }),
        (err: Error) => {
          assert.ok(err instanceof BridgePanicError);
          assert.equal(err.message, "wrong secret");
          return true;
        },
      );
    });
  });
});
