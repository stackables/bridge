import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  parseBridgeFormat as parseBridge,
  serializeBridge,
} from "../src/index.ts";
import { BridgePanicError } from "../src/index.ts";
import { regressionTest } from "./utils/regression.ts";
import { tools } from "./utils/bridge-tools.ts";
import { executeBridge as executeRuntime } from "@stackables/bridge-core";
import { executeBridge as executeCompiled } from "@stackables/bridge-compiler";
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

// Direct execution helpers (for tests with serializer issues)
const directEngines = [
  { name: "runtime", execute: executeRuntime },
  { name: "compiled", execute: executeCompiled },
] as const;

function directRun(
  execute: typeof executeRuntime,
  bridgeText: string,
  operation: string,
  input: Record<string, unknown>,
  toolMap: Record<string, any> = {},
) {
  const raw = parseBridge(bridgeText);
  const document = JSON.parse(JSON.stringify(raw));
  return (execute as any)({ document, operation, input, tools: toolMap });
}

// ── Basic ternary: ref + literal branches ─────────────────────────────────

regressionTest("ternary: basic + literal branches", {
  bridge: `
    version 1.5

    bridge Ternary.basic {
      with input as i
      with output as o

      o.amount <- i.isPro ? i.proPrice : i.basicPrice
      o.tier <- i.isPro ? "premium" : "basic"
      o.discount <- i.isPro ? 20 : 0
    }
  `,
  scenarios: {
    "Ternary.basic": {
      "truthy condition selects then branches": {
        input: { isPro: true, proPrice: 99.99, basicPrice: 9.99 },
        assertData: { amount: 99.99, tier: "premium", discount: 20 },
        assertTraces: 0,
      },
      "falsy condition selects else branches": {
        input: { isPro: false, proPrice: 99.99, basicPrice: 9.99 },
        assertData: { amount: 9.99, tier: "basic", discount: 0 },
        assertTraces: 0,
      },
    },
  },
});

// ── Expression condition ──────────────────────────────────────────────────

regressionTest("ternary: expression condition", {
  bridge: `
    version 1.5

    bridge Ternary.expression {
      with input as i
      with output as o

      o.result <- i.age >= 18 ? i.proPrice : i.basicPrice
    }
  `,
  scenarios: {
    "Ternary.expression": {
      "adult (age >= 18) selects then branch": {
        input: { age: 20, proPrice: 99, basicPrice: 9 },
        assertData: { result: 99 },
        assertTraces: 0,
      },
      "minor (age < 18) selects else branch": {
        input: { age: 15, proPrice: 99, basicPrice: 9 },
        assertData: { result: 9 },
        assertTraces: 0,
      },
    },
  },
});

// ── Fallbacks ─────────────────────────────────────────────────────────────

regressionTest("ternary: fallbacks", {
  bridge: `
    version 1.5

    bridge Ternary.literalFallback {
      with input as i
      with output as o

      o.amount <- i.isPro ? i.proPrice : i.basicPrice || 0
    }

    bridge Ternary.catchFallback {
      with test.multitool as proTool
      with input as i
      with output as o

      proTool <- i.proTool

      o.amount <- i.isPro ? proTool.price : i.basicPrice catch -1
    }

    bridge Ternary.refFallback {
      with test.multitool as fb
      with input as i
      with output as o

      fb <- i.fb

      o.amount <- i.isPro ? i.proPrice : i.basicPrice || fb.defaultPrice
    }
  `,
  tools: tools,
  scenarios: {
    "Ternary.literalFallback": {
      "falsy, basicPrice null → || 0 fires": {
        input: { isPro: false, proPrice: 99 },
        assertData: { amount: 0 },
        assertTraces: 0,
      },
      "truthy, proPrice present → then branch": {
        input: { isPro: true, proPrice: 99, basicPrice: 9 },
        assertData: { amount: 99 },
        assertTraces: 0,
      },
      "falsy, basicPrice present → else branch": {
        input: { isPro: false, proPrice: 99, basicPrice: 9 },
        assertData: { amount: 9 },
        assertTraces: 0,
      },
    },
    "Ternary.catchFallback": {
      "truthy, proTool throws → catch fires": {
        input: { isPro: true, basicPrice: 9, proTool: { _error: "api down" } },
        assertData: { amount: -1 },
        assertTraces: 1,
      },
      "truthy, proTool succeeds → then branch": {
        input: { isPro: true, basicPrice: 9, proTool: { price: 99 } },
        assertData: { amount: 99 },
        assertTraces: 1,
      },
      "falsy → else branch": {
        input: { isPro: false, basicPrice: 9 },
        assertData: { amount: 9 },
        assertTraces: 0,
      },
    },
    "Ternary.refFallback": {
      "falsy, basicPrice null → || fb.defaultPrice fires": {
        input: { isPro: false, proPrice: 99, fb: { defaultPrice: 5 } },
        assertData: { amount: 5 },
        assertTraces: 1,
      },
      "truthy, proPrice present → then branch": {
        input: { isPro: true, proPrice: 99, fb: { defaultPrice: 5 } },
        assertData: { amount: 99 },
        assertTraces: 1,
      },
      "falsy, basicPrice present → else branch": {
        input: { isPro: false, basicPrice: 9, fb: { defaultPrice: 5 } },
        assertData: { amount: 9 },
        assertTraces: 1,
      },
    },
  },
});

// ── Tool branches (lazy evaluation) ───────────────────────────────────────

regressionTest("ternary: tool branches (lazy evaluation)", {
  bridge: `
    version 1.5

    bridge Ternary.toolBranches {
      with test.multitool as proTool
      with test.multitool as basicTool
      with input as i
      with output as o

      proTool <- i.proTool
      basicTool <- i.basicTool

      o.price <- i.isPro ? proTool.price : basicTool.price
    }
  `,
  tools: tools,
  scenarios: {
    "Ternary.toolBranches": {
      "truthy → only chosen branch tool fires": {
        input: {
          isPro: true,
          proTool: { price: 99.99 },
          basicTool: { price: 9.99 },
        },
        assertData: { price: 99.99 },
        assertTraces: 1,
      },
      "falsy → only chosen branch tool fires": {
        input: {
          isPro: false,
          proTool: { price: 99.99 },
          basicTool: { price: 9.99 },
        },
        assertData: { price: 9.99 },
        assertTraces: 1,
      },
    },
  },
});

// ── Ternary in array mapping (serializer issues — direct execution) ──────

describe("ternary in array mapping", () => {
  const bridgeText = `version 1.5
bridge Query.products {
  with catalog.list as api
  with output as o
  o <- api.items[] as item {
    .name <- item.name
    .price <- item.isPro ? item.proPrice : item.basicPrice
  }
}`;
  const catalogTools = {
    "catalog.list": async () => ({
      items: [
        { name: "Widget", isPro: true, proPrice: 99, basicPrice: 9 },
        { name: "Gadget", isPro: false, proPrice: 199, basicPrice: 19 },
      ],
    }),
  };

  for (const { name, execute } of directEngines) {
    test(`[${name}] ternary works inside array element mapping`, async () => {
      const { data } = await directRun(
        execute,
        bridgeText,
        "Query.products",
        {},
        catalogTools,
      );
      const products = data as any[];
      assert.equal(products[0].name, "Widget");
      assert.equal(products[0].price, 99, "isPro=true → proPrice");
      assert.equal(products[1].name, "Gadget");
      assert.equal(products[1].price, 19, "isPro=false → basicPrice");
    });
  }
});

// ── Alias + ternary with panic/fallback (serializer issues — direct) ─────

describe("alias + ternary with panic/fallback modifiers (Lazy Gate)", () => {
  const geoSrc = `version 1.5
bridge Query.location {
  with geoApi as geo
  with input as i
  with output as o

  alias (i.age >= 18) ? i : null ?? panic "Must be 18 or older" as ageChecked

  geo.q <- ageChecked?.city

  o.lat <- geo[0].lat
  o.lon <- geo[0].lon
}`;
  const geoTools = {
    geoApi: async () => [{ lat: 47.37, lon: 8.54 }],
  };

  for (const { name, execute } of directEngines) {
    describe(`[${name}]`, () => {
      test("alias ternary + ?? panic fires on false branch → null", async () => {
        await assert.rejects(
          () =>
            directRun(
              execute,
              geoSrc,
              "Query.location",
              { age: 15, city: "Zurich" },
              geoTools,
            ),
          (err: Error) => {
            assert.ok(err instanceof BridgePanicError);
            assert.equal(err.message, "Must be 18 or older");
            return true;
          },
        );
      });

      test("alias ternary + ?? panic does NOT fire when condition is true", async () => {
        const { data } = await directRun(
          execute,
          geoSrc,
          "Query.location",
          { age: 25, city: "Zurich" },
          geoTools,
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
        const { data } = await directRun(execute, src, "Query.test", {
          score: 30,
        });
        assert.equal((data as any).grade, "F");
      });

      test("alias ternary + || ref fallback", async () => {
        const src = `version 1.5
bridge Query.test {
  with test.multitool as fb
  with input as i
  with output as o
  fb <- i.fb
  alias i.score >= 50 ? i.grade : null || fb.grade as grade
  o.grade <- grade
}`;
        const { data } = await directRun(
          execute,
          src,
          "Query.test",
          { score: 30, fb: { grade: "F" } },
          tools as any,
        );
        assert.equal((data as any).grade, "F");
      });

      test("alias ternary + catch literal fallback", async () => {
        const src = `version 1.5
bridge Query.test {
  with test.multitool as a
  with input as i
  with output as o
  a <- i.a
  alias a.ok ? a.value : a.alt catch "safe" as result
  o.val <- result
}`;
        const { data } = await directRun(
          execute,
          src,
          "Query.test",
          { a: { _error: "boom" } },
          tools as any,
        );
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
          () =>
            directRun(execute, src, "Query.test", { secret: "world" }),
          (err: Error) => {
            assert.ok(err instanceof BridgePanicError);
            assert.equal(err.message, "wrong secret");
            return true;
          },
        );
      });
    });
  }
});
