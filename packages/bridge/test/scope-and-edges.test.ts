import { buildHTTPExecutor } from "@graphql-tools/executor-http";
import { parse } from "graphql";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  parseBridge,
  parsePath,
  serializeBridge,
} from "../src/bridge-format.js";
import { createGateway } from "./_gateway.js";

// ═══════════════════════════════════════════════════════════════════════════
// 1. Nested shadow tree — scope chain leak
//
//    When a tool returns nested arrays (journeys containing stops), the
//    bridge creates shadow ExecutionTrees. If the outer array is mapped
//    with [] as {} and the inner array is passed through, GraphQL creates
//    shadow trees at BOTH levels. A grandchild shadow tree only checks
//    one parent level for state/context — failing to reach the root.
//
//    Concrete scenario: outer array is mapped, inner array is passed
//    through. The inner array's scalar fields should resolve from the
//    element data stored in the shadow tree.
// ═══════════════════════════════════════════════════════════════════════════

describe("nested shadow scope chain", () => {
  const typeDefs = /* GraphQL */ `
    type Query {
      plan(origin: String!): Plan
    }
    type Plan {
      journeys: [Journey!]!
    }
    type Journey {
      label: String
      stops: [Stop!]!
    }
    type Stop {
      name: String
      eta: String
    }
  `;

  // Map the outer array with [] as {}, pass inner array through
  const bridgeText = `version 1.4
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
    router: async (params: { origin: string }) => ({
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

  function makeExecutor() {
    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, { tools });
    return buildHTTPExecutor({ fetch: gateway.fetch as any });
  }

  test("outer array fields resolve correctly", async () => {
    const executor = makeExecutor();
    const result: any = await executor({
      document: parse(`{
        plan(origin: "Berlin") {
          journeys { label }
        }
      }`),
    });

    assert.ok(
      !result.errors,
      `should not error: ${JSON.stringify(result.errors)}`,
    );
    assert.equal(result.data.plan.journeys.length, 2);
    assert.equal(result.data.plan.journeys[0].label, "Express");
    assert.equal(result.data.plan.journeys[1].label, "Local");
  });

  test("inner array passed through: scalar fields resolve from element data", async () => {
    // This is the key test for the scope chain bug.
    // The inner [Stop] array creates grandchild shadow trees.
    // Their scalar fields (name, eta) must resolve from the stored element data.
    const executor = makeExecutor();
    const result: any = await executor({
      document: parse(`{
        plan(origin: "Berlin") {
          journeys { label stops { name eta } }
        }
      }`),
    });

    assert.ok(
      !result.errors,
      `should not error: ${JSON.stringify(result.errors)}`,
    );
    const journeys = result.data.plan.journeys;
    assert.equal(journeys.length, 2);

    // First journey's stops
    assert.equal(journeys[0].stops.length, 2);
    assert.equal(journeys[0].stops[0].name, "A");
    assert.equal(journeys[0].stops[0].eta, "09:00");
    assert.equal(journeys[0].stops[1].name, "B");
    assert.equal(journeys[0].stops[1].eta, "09:30");

    // Second journey's stops
    assert.equal(journeys[1].stops.length, 3);
    assert.equal(journeys[1].stops[2].name, "Z");
    assert.equal(journeys[1].stops[2].eta, "11:30");
  });

  test("context accessible from tool triggered by nested array data", async () => {
    // Tool definition uses `with context` to pull an API key.
    // The result contains nested arrays. The context lookup in
    // resolveToolSource checks only this.context ?? this.parent?.context.
    // If the tree is 2+ levels deep, context is lost.
    const contextTypeDefs = /* GraphQL */ `
      type Query {
        trips(origin: String!): TripPlan
      }
      type TripPlan {
        routes: [Route!]!
      }
      type Route {
        carrier: String
        legs: [Leg!]!
      }
      type Leg {
        from: String
        to: String
      }
    `;

    const contextBridgeText = `version 1.4
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

    const instructions = parseBridge(contextBridgeText);
    const gateway = createGateway(contextTypeDefs, instructions, {
      context: { apiKey: "secret-123" },
      tools: { httpCall },
    });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(
        `{ trips(origin: "Berlin") { routes { carrier legs { from to } } } }`,
      ),
    });

    assert.ok(
      !result.errors,
      `should not error: ${JSON.stringify(result.errors)}`,
    );
    // Context should flow through to the tool
    assert.equal(capturedInput.headers?.apiKey, "secret-123");

    // Nested array data resolved correctly
    assert.equal(result.data.trips.routes[0].carrier, "TrainCo");
    assert.equal(result.data.trips.routes[0].legs[0].from, "Berlin");
    assert.equal(result.data.trips.routes[0].legs[0].to, "Hamburg");
    assert.equal(result.data.trips.routes[0].legs[1].from, "Hamburg");
    assert.equal(result.data.trips.routes[0].legs[1].to, "Copenhagen");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Tool extends: child overriding a parent with duplicate target wires
//
//    resolveToolDefByName merges wires by finding the first match on
//    `target` and replacing it. If the parent has two wires with the same
//    target (e.g., a constant + pull, or from future || support), only
//    the first is replaced — the second leaks through.
// ═══════════════════════════════════════════════════════════════════════════

describe("tool extends with duplicate target override", () => {
  const typeDefs = /* GraphQL */ `
    type Query {
      locate(q: String!): Location
    }
    type Location {
      lat: Float
      name: String
    }
  `;

  test("child constant replaces parent constant + pull for same target", async () => {
    // Parent has TWO wires for "headers.Authorization":
    //   1. .headers.Authorization <- context.token (pull)
    //   2. .headers.Authorization = "fallback"     (constant, e.g. default)
    // Child overrides with a single constant.
    // Bug: findIndex replaces #1, but #2 leaks through.
    const bridgeText = `version 1.4
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

}`;

    let capturedInput: Record<string, any> = {};
    const myTool = async (input: Record<string, any>) => {
      capturedInput = input;
      return { lat: 52.5, name: "Berlin" };
    };

    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, {
      context: { token: "parent-token" },
      tools: { myTool },
    });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ locate(q: "test") { lat name } }`),
    });

    assert.ok(
      !result.errors,
      `should not error: ${JSON.stringify(result.errors)}`,
    );
    // The child's constant "child-value" should be the ONLY value.
    // Neither the parent's pull ("parent-token") nor constant ("fallback")
    // should leak through.
    assert.equal(
      capturedInput.headers?.Authorization,
      "child-value",
      "child should fully replace all parent wires for headers.Authorization",
    );
  });

  test("child pull replaces parent constant for same target", async () => {
    // Parent: .method = GET (constant)
    // Parent: .method = POST (another constant — contrived but valid parse)
    // Child: .method <- context.httpMethod (pull)
    // Bug: First parent wire replaced, second leaks
    const bridgeText = `version 1.4
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

}`;

    let capturedInput: Record<string, any> = {};
    const myTool = async (input: Record<string, any>) => {
      capturedInput = input;
      return { lat: 0, name: "Test" };
    };

    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, {
      context: { httpMethod: "PATCH" },
      tools: { myTool },
    });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    await executor({
      document: parse(`{ locate(q: "x") { lat } }`),
    });

    // Child's pull should be the only wire for "method"
    assert.equal(
      capturedInput.method,
      "PATCH",
      "child pull should replace ALL parent wires for 'method' (both GET and POST constants)",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Array indices in paths — parser allows `o.items[0].lat` which
//    creates path ["items","0","lat"], but response() strips numeric
//    indices from the GraphQL path, so the wire never matches.
// ═══════════════════════════════════════════════════════════════════════════

describe("array index in output path", () => {
  test("parsePath produces index segments from [N] syntax", () => {
    const segments = parsePath("results[0].lat");
    assert.deepStrictEqual(segments, ["results", "0", "lat"]);
  });

  test("explicit index on output LHS should either error at parse or work at runtime", () => {
    const bridgeText = `version 1.4
bridge Query.thing {
  with api as a
  with input as i
  with output as o

a.q <- i.q
o.items[0].name <- a.firstName

}`;

    // Currently: parses fine but wire path ["items","0","name"] never matches
    // at runtime because response() strips indices from the GraphQL path.
    // This is the silent-failure scenario — the worst option.
    //
    // Expected: either throw at parse time (Option A — preferred)
    // or make it work at runtime (Option B).
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
      // Fixed: parser rejects explicit indices on the target side
      assert.ok(parseError!.message.length > 0, "should give a useful error");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. setNested sparse array creation
//    setNested creates [] when the next path key is numeric, but this
//    produces sparse arrays. Not a bug per se — documents the concern.
// ═══════════════════════════════════════════════════════════════════════════

describe("setNested sparse arrays", () => {
  test("documented concern: sparse arrays are created when explicit indices are allowed", () => {
    // The real protection is issue #3: forbid explicit indices on output LHS.
    // If that's enforced, sparse arrays from bridge wiring can't happen.
    // This test is a placeholder acknowledging the concern.
    assert.ok(
      true,
      "Sparse arrays are a concern if explicit indices are allowed in output paths",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Nested array-in-array mapping (explicit field wiring)
//
//    When a bridge maps an outer array AND explicitly maps fields of a
//    nested inner array using `[] as iter { ... }` syntax inside an
//    element block, the parser, serializer, and runtime must all handle
//    the recursion correctly.
//
//    This is the pattern used by the travel-api example where journeys[]
//    contain legs[], and each leg's fields are explicitly remapped.
// ═══════════════════════════════════════════════════════════════════════════

describe("nested array-in-array mapping", () => {
  const typeDefs = /* GraphQL */ `
    type Query {
      searchTrains(from: String!, to: String!): [Journey!]!
    }
    type Journey {
      id: ID!
      provider: String!
      legs: [Leg!]!
    }
    type Leg {
      trainName: String
      originStation: String
      destStation: String
    }
  `;

  const bridgeText = `version 1.4

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

  const mockHttpCall = async (input: Record<string, any>) => ({
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

  function makeExecutor() {
    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, {
      tools: { httpCall: mockHttpCall },
    });
    return buildHTTPExecutor({ fetch: gateway.fetch as any });
  }

  test("parse produces correct arrayIterators for nested arrays", () => {
    const instructions = parseBridge(bridgeText);
    const bridge = instructions.find((i): i is any => i.kind === "bridge");
    assert.ok(bridge, "bridge instruction must exist");
    // Root array iterator
    assert.equal(bridge.arrayIterators[""], "j");
    // Nested array iterator
    assert.equal(bridge.arrayIterators["legs"], "l");
  });

  test("roundtrip: parse → serialize → parse preserves nested array structure", () => {
    const instructions = parseBridge(bridgeText);
    const serialized = serializeBridge(instructions);
    const reparsed = parseBridge(serialized);

    const origBridge = instructions.find((i): i is any => i.kind === "bridge");
    const reparsedBridge = reparsed.find((i): i is any => i.kind === "bridge");

    // Same number of wires
    assert.equal(
      reparsedBridge.wires.length,
      origBridge.wires.length,
      `wire count: expected ${origBridge.wires.length}, got ${reparsedBridge.wires.length}`,
    );

    // Same arrayIterators
    assert.deepEqual(reparsedBridge.arrayIterators, origBridge.arrayIterators);
  });

  test("runtime: outer array fields resolve correctly", async () => {
    const executor = makeExecutor();
    const result: any = await executor({
      document: parse(`{
        searchTrains(from: "Berlin", to: "Hamburg") { id provider }
      }`),
    });

    assert.ok(
      !result.errors,
      `should not error: ${JSON.stringify(result.errors)}`,
    );
    assert.equal(result.data.searchTrains.length, 2);
    assert.equal(result.data.searchTrains[0].id, "ABC");
    assert.equal(result.data.searchTrains[0].provider, "TRAIN");
    assert.equal(result.data.searchTrains[1].id, "unknown"); // null-fallback
    assert.equal(result.data.searchTrains[1].provider, "TRAIN");
  });

  test("runtime: nested inner array fields resolve with explicit mapping", async () => {
    const executor = makeExecutor();
    const result: any = await executor({
      document: parse(`{
        searchTrains(from: "Berlin", to: "Hamburg") {
          id
          legs { trainName originStation destStation }
        }
      }`),
    });

    assert.ok(
      !result.errors,
      `should not error: ${JSON.stringify(result.errors)}`,
    );
    const trains = result.data.searchTrains;

    // First journey: 2 legs
    assert.equal(trains[0].legs.length, 2);
    assert.equal(trains[0].legs[0].trainName, "ICE 100");
    assert.equal(trains[0].legs[0].originStation, "Berlin");
    assert.equal(trains[0].legs[0].destStation, "Hamburg");
    assert.equal(trains[0].legs[1].trainName, "Walk"); // null-fallback
    assert.equal(trains[0].legs[1].originStation, "Hamburg");
    assert.equal(trains[0].legs[1].destStation, "Copenhagen");

    // Second journey: 1 leg
    assert.equal(trains[1].legs.length, 1);
    assert.equal(trains[1].legs[0].trainName, "IC 200");
    assert.equal(trains[1].legs[0].originStation, "Munich");
    assert.equal(trains[1].legs[0].destStation, "Vienna");
  });
});
