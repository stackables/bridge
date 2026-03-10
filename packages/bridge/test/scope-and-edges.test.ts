import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  parseBridgeFormat as parseBridge,
  serializeBridge,
} from "@stackables/bridge-parser";
import { parsePath } from "@stackables/bridge-core";
import { forEachEngine } from "./utils/dual-run.ts";

// ═══════════════════════════════════════════════════════════════════════════
// 1. Nested shadow tree — scope chain
// ═══════════════════════════════════════════════════════════════════════════

forEachEngine("nested shadow scope chain", (run, { engine }) => {
  const bridgeText = `version 1.5
bridge Query.plan {
  with router as r
  with input as i
  with output as o

r.origin <- i.origin
o.journeys <- r.journeys[] as j {
  .label <- j.label
  .stops <- j.stops
}

}`;

  const tools = {
    router: async (_params: { origin: string }) => ({
      journeys: [
        {
          label: "Express",
          stops: [
            { name: "A", eta: "09:00" },
            { name: "B", eta: "09:30" },
          ],
        },
        {
          label: "Local",
          stops: [
            { name: "X", eta: "10:00" },
            { name: "Y", eta: "10:45" },
            { name: "Z", eta: "11:30" },
          ],
        },
      ],
    }),
  };

  test("outer array fields resolve correctly", async () => {
    const { data } = await run(
      bridgeText,
      "Query.plan",
      { origin: "Berlin" },
      tools,
    );
    assert.equal(data.journeys.length, 2);
    assert.equal(data.journeys[0].label, "Express");
    assert.equal(data.journeys[1].label, "Local");
  });

  test("inner array passed through: scalar fields resolve from element data", async () => {
    const { data } = await run(
      bridgeText,
      "Query.plan",
      { origin: "Berlin" },
      tools,
    );
    const journeys = data.journeys;
    assert.equal(journeys.length, 2);
    assert.equal(journeys[0].stops.length, 2);
    assert.equal(journeys[0].stops[0].name, "A");
    assert.equal(journeys[0].stops[0].eta, "09:00");
    assert.equal(journeys[0].stops[1].name, "B");
    assert.equal(journeys[0].stops[1].eta, "09:30");
    assert.equal(journeys[1].stops.length, 3);
    assert.equal(journeys[1].stops[2].name, "Z");
    assert.equal(journeys[1].stops[2].eta, "11:30");
  });

  test(
    "context accessible from tool triggered by nested array data",
    { skip: engine === "compiled" },
    async () => {
      let capturedInput: Record<string, any> = {};
      const httpCall = async (input: Record<string, any>) => {
        capturedInput = input;
        return {
          routes: [
            {
              carrier: "TrainCo",
              legs: [
                { from: "Berlin", to: "Hamburg" },
                { from: "Hamburg", to: "Copenhagen" },
              ],
            },
          ],
        };
      };

      const contextBridgeText = `version 1.5
tool routeApi from httpCall {
  with context
  .baseUrl = "http://mock"
  .method = GET
  .path = /routes
  .headers.apiKey <- context.apiKey

}

bridge Query.trips {
  with routeApi as r
  with input as i
  with output as o

r.origin <- i.origin
o.routes <- r.routes[] as route {
  .carrier <- route.carrier
  .legs <- route.legs
}

}`;

      const { data } = await run(
        contextBridgeText,
        "Query.trips",
        { origin: "Berlin" },
        { httpCall },
        { context: { apiKey: "secret-123" } },
      );

      assert.equal(capturedInput.headers?.apiKey, "secret-123");
      assert.equal(data.routes[0].carrier, "TrainCo");
      assert.equal(data.routes[0].legs[0].from, "Berlin");
      assert.equal(data.routes[0].legs[0].to, "Hamburg");
      assert.equal(data.routes[0].legs[1].from, "Hamburg");
      assert.equal(data.routes[0].legs[1].to, "Copenhagen");
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Tool extends: duplicate target override
// ═══════════════════════════════════════════════════════════════════════════

forEachEngine(
  "tool extends with duplicate target override",
  (run, { engine }) => {
    test(
      "child constant replaces parent constant + pull for same target",
      { skip: engine === "compiled" },
      async () => {
        let capturedInput: Record<string, any> = {};
        const myTool = async (input: Record<string, any>) => {
          capturedInput = input;
          return { lat: 52.5, name: "Berlin" };
        };

        await run(
          `version 1.5
tool base from myTool {
  with context
  .headers.Authorization <- context.token
  .headers.Authorization = "fallback"

}
tool base.child from base {
  .headers.Authorization = "child-value"

}

bridge Query.locate {
  with base.child as b
  with input as i
  with output as o

b.q <- i.q
o.lat <- b.lat
o.name <- b.name

}`,
          "Query.locate",
          { q: "test" },
          { myTool },
          { context: { token: "parent-token" } },
        );

        assert.equal(
          capturedInput.headers?.Authorization,
          "child-value",
          "child should fully replace all parent wires",
        );
      },
    );

    test("child pull replaces parent constant for same target", async () => {
      let capturedInput: Record<string, any> = {};
      const myTool = async (input: Record<string, any>) => {
        capturedInput = input;
        return { lat: 0, name: "Test" };
      };

      await run(
        `version 1.5
tool base from myTool {
  .baseUrl = "http://test"
  .method = GET
  .method = POST

}
tool base.child from base {
  with context
  .method <- context.httpMethod

}

bridge Query.locate {
  with base.child as b
  with input as i
  with output as o

b.q <- i.q
o.lat <- b.lat
o.name <- b.name

}`,
        "Query.locate",
        { q: "x" },
        { myTool },
        { context: { httpMethod: "PATCH" } },
      );

      assert.equal(
        capturedInput.method,
        "PATCH",
        "child pull should replace ALL parent wires for 'method'",
      );
    });
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// 3. Array indices in paths
// ═══════════════════════════════════════════════════════════════════════════

describe("array index in output path", () => {
  test("parsePath produces index segments from [N] syntax", () => {
    const segments = parsePath("results[0].lat");
    assert.deepStrictEqual(segments, ["results", "0", "lat"]);
  });

  test("explicit index on output LHS should either error at parse or work at runtime", () => {
    const bridgeText = `version 1.5
bridge Query.thing {
  with api as a
  with input as i
  with output as o

a.q <- i.q
o.items[0].name <- a.firstName

}`;

    let parsed = false;
    let parseError: Error | undefined;
    try {
      parseBridge(bridgeText);
      parsed = true;
    } catch (e) {
      parseError = e as Error;
    }

    if (parsed) {
      assert.fail(
        "KNOWN ISSUE: explicit index on output LHS parses but silently produces null at runtime. " +
          "Parser should reject `o.items[0].name` — use array mapping blocks instead.",
      );
    } else {
      assert.ok(parseError!.message.length > 0, "should give a useful error");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. setNested sparse array concern
// ═══════════════════════════════════════════════════════════════════════════

describe("setNested sparse arrays", () => {
  test("documented concern: sparse arrays are created when explicit indices are allowed", () => {
    assert.ok(
      true,
      "Sparse arrays are a concern if explicit indices are allowed in output paths",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Nested array-in-array mapping
// ═══════════════════════════════════════════════════════════════════════════

forEachEngine("nested array-in-array mapping", (run) => {
  const bridgeText = `version 1.5

tool trainApi from httpCall {
  .baseUrl = "http://mock"
  .method = GET
  .path = /journeys
  on error = { "journeys": [] }
}

bridge Query.searchTrains {
  with trainApi as api
  with input as i
  with output as o

  api.from <- i.from
  api.to <- i.to

  o <- api.journeys[] as j {
    .id <- j.token || "unknown"
    .provider = "TRAIN"
    .legs <- j.legs[] as l {
      .trainName <- l.line.name || "Walk"
      .originStation <- l.origin.name
      .destStation <- l.destination.name
    }
  }
}`;

  const mockHttpCall = async (_input: Record<string, any>) => ({
    journeys: [
      {
        token: "ABC",
        legs: [
          {
            line: { name: "ICE 100" },
            origin: { name: "Berlin" },
            destination: { name: "Hamburg" },
          },
          {
            line: { name: null },
            origin: { name: "Hamburg" },
            destination: { name: "Copenhagen" },
          },
        ],
      },
      {
        token: null,
        legs: [
          {
            line: { name: "IC 200" },
            origin: { name: "Munich" },
            destination: { name: "Vienna" },
          },
        ],
      },
    ],
  });

  test("parse produces correct arrayIterators for nested arrays", () => {
    const doc = parseBridge(bridgeText);
    const bridge = doc.instructions.find((i): i is any => i.kind === "bridge");
    assert.ok(bridge, "bridge instruction must exist");
    assert.equal(bridge.arrayIterators[""], "j");
    assert.equal(bridge.arrayIterators["legs"], "l");
  });

  test("roundtrip: parse → serialize → parse preserves nested array structure", () => {
    const doc = parseBridge(bridgeText);
    const serialized = serializeBridge(doc);
    const reparsed = parseBridge(serialized);

    const origBridge = doc.instructions.find(
      (i): i is any => i.kind === "bridge",
    );
    const reparsedBridge = reparsed.instructions.find(
      (i): i is any => i.kind === "bridge",
    );

    assert.equal(
      reparsedBridge.wires.length,
      origBridge.wires.length,
      "wire count matches",
    );
    assert.deepEqual(reparsedBridge.arrayIterators, origBridge.arrayIterators);
  });

  test("runtime: outer array fields resolve correctly", async () => {
    const { data } = await run(
      bridgeText,
      "Query.searchTrains",
      { from: "Berlin", to: "Hamburg" },
      { httpCall: mockHttpCall },
    );
    assert.equal(data.length, 2);
    assert.equal(data[0].id, "ABC");
    assert.equal(data[0].provider, "TRAIN");
    assert.equal(data[1].id, "unknown");
    assert.equal(data[1].provider, "TRAIN");
  });

  test("runtime: nested inner array fields resolve with explicit mapping", async () => {
    const { data } = await run(
      bridgeText,
      "Query.searchTrains",
      { from: "Berlin", to: "Hamburg" },
      { httpCall: mockHttpCall },
    );

    assert.equal(data[0].legs.length, 2);
    assert.equal(data[0].legs[0].trainName, "ICE 100");
    assert.equal(data[0].legs[0].originStation, "Berlin");
    assert.equal(data[0].legs[0].destStation, "Hamburg");
    assert.equal(data[0].legs[1].trainName, "Walk");
    assert.equal(data[0].legs[1].originStation, "Hamburg");
    assert.equal(data[0].legs[1].destStation, "Copenhagen");

    assert.equal(data[1].legs.length, 1);
    assert.equal(data[1].legs[0].trainName, "IC 200");
    assert.equal(data[1].legs[0].originStation, "Munich");
    assert.equal(data[1].legs[0].destStation, "Vienna");
  });
});
