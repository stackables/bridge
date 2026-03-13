import assert from "node:assert/strict";
import { regressionTest } from "./utils/regression.ts";

// ═══════════════════════════════════════════════════════════════════════════
// Scope & edge cases — nested scopes, tool extends, array indices,
// nested array-in-array mapping
//
// Migrated from legacy/scope-and-edges.test.ts
// ═══════════════════════════════════════════════════════════════════════════

// ── 1. Nested shadow scope chain ────────────────────────────────────────────

regressionTest("nested shadow scope chain", {
  bridge: `
    version 1.5

    bridge Query.plan {
      with router as r
      with input as i
      with output as o

      r.origin <- i.origin
      o.journeys <- r.journeys[] as j {
        .label <- j.label
        .stops <- j.stops
      }
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
    }
  `,
  tools: {
    router: async () => ({
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
    routeApi: async () => ({
      routes: [
        {
          carrier: "TrainCo",
          legs: [
            { from: "Berlin", to: "Hamburg" },
            { from: "Hamburg", to: "Copenhagen" },
          ],
        },
      ],
    }),
  },
  scenarios: {
    "Query.plan": {
      "outer array fields resolve correctly": {
        input: { origin: "Berlin" },
        assertData: (data: any) => {
          assert.equal(data.journeys.length, 2);
          assert.equal(data.journeys[0].label, "Express");
          assert.equal(data.journeys[1].label, "Local");
        },
        assertTraces: 1,
      },
      "inner array passed through as scalar": {
        input: { origin: "Berlin" },
        assertData: {
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
        },
        assertTraces: 1,
      },
      "empty journeys": {
        input: { origin: "empty" },
        tools: { router: async () => ({ journeys: [] }) },
        assertData: { journeys: [] },
        assertTraces: 1,
      },
    },
    "Query.trips": {
      "context-driven tool with nested array": {
        input: { origin: "Berlin" },
        assertData: {
          routes: [
            {
              carrier: "TrainCo",
              legs: [
                { from: "Berlin", to: "Hamburg" },
                { from: "Hamburg", to: "Copenhagen" },
              ],
            },
          ],
        },
        assertTraces: 1,
      },
      "empty routes": {
        input: { origin: "x" },
        tools: { routeApi: async () => ({ routes: [] }) },
        assertData: { routes: [] },
        assertTraces: 1,
      },
    },
  },
});

// ── 2. Tool extends: duplicate target override ──────────────────────────────

regressionTest("tool extends with duplicate target override", {
  bridge: `
    version 1.5

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
    }
  `,
  tools: {
    myTool: async () => ({ lat: 0, name: "Test" }),
  },
  scenarios: {
    "Query.locate": {
      "child pull replaces parent constant for same target": {
        input: { q: "x" },
        context: { httpMethod: "PATCH" },
        assertData: { lat: 0, name: "Test" },
        assertTraces: 1,
      },
    },
  },
});

// ── 3. Nested array-in-array mapping ────────────────────────────────────────

const mockHttpCall = async () => ({
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

regressionTest("nested array-in-array mapping", {
  bridge: `
    version 1.5

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
    }
  `,
  tools: { httpCall: mockHttpCall },
  scenarios: {
    "Query.searchTrains": {
      "nested arrays resolve with fallback and constants": {
        input: { from: "Berlin", to: "Hamburg" },
        assertData: [
          {
            id: "ABC",
            provider: "TRAIN",
            legs: [
              {
                trainName: "ICE 100",
                originStation: "Berlin",
                destStation: "Hamburg",
              },
              {
                trainName: "Walk",
                originStation: "Hamburg",
                destStation: "Copenhagen",
              },
            ],
          },
          {
            id: "unknown",
            provider: "TRAIN",
            legs: [
              {
                trainName: "IC 200",
                originStation: "Munich",
                destStation: "Vienna",
              },
            ],
          },
        ],
        assertTraces: 1,
      },
      "empty journeys via on error": {
        input: { from: "Berlin", to: "Hamburg" },
        tools: {
          httpCall: async () => {
            throw new Error("API down");
          },
        },
        assertData: [],
        assertTraces: 1,
      },
      "empty legs": {
        input: { from: "Berlin", to: "Hamburg" },
        tools: {
          httpCall: async () => ({
            journeys: [{ token: "X", legs: [] }],
          }),
        },
        assertData: [{ id: "X", provider: "TRAIN", legs: [] }],
        assertTraces: 1,
      },
    },
  },
});
