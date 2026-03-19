import { regressionTest } from "../utils/regression.ts";

// ═══════════════════════════════════════════════════════════════════════════
// Scope block inside nested array body — regression
//
// Bug report (v1.5): When a scope block (e.g. `.destination { .station { } }`)
// appears inside a nested array body (e.g. `[] as s { ... }`), the wires
// inside the scope block are not flagged as element-scoped. They write to the
// root output instead of the per-element output, so the path-scoped section
// is entirely missing from results.
//
// A secondary symptom is that pipe expressions (`uc:s.departure.station.name`)
// whose handle is declared at bridge scope (not inside the array body) don't
// show up as "used" in tracing when the pipe is inside scope blocks in arrays.
// ═══════════════════════════════════════════════════════════════════════════

regressionTest("nested scope block inside nested array body", {
  bridge: `
    version 1.5

    bridge Query.searchTrains {
      with context as ctx
      with output as o
      with std.str.toUpperCase as uc

      o <- ctx.connections[] as c {
        .legs <- c.sections[] as s {
          .origin.station.id <- s.departure.station.id
          .origin.station.name <- uc:s.departure.station.name

          .destination {
            .station {
              .id <- s.arrival.station.id
              .name <- uc:s.arrival.station.name
            }
          }
        }
      }
    }
  `,
  scenarios: {
    "Query.searchTrains": {
      "scope block inside inner array body produces destination section": {
        input: {},
        context: {
          connections: [
            {
              sections: [
                {
                  departure: { station: { id: "dep1", name: "bern" } },
                  arrival: { station: { id: "arr1", name: "zurich" } },
                },
              ],
            },
          ],
        },
        assertData: [
          {
            legs: [
              {
                origin: { station: { id: "dep1", name: "BERN" } },
                destination: { station: { id: "arr1", name: "ZURICH" } },
              },
            ],
          },
        ],
        assertTraces: 0,
      },
      "empty connections array": {
        input: {},
        context: { connections: [] },
        assertData: [],
        assertTraces: 0,
      },
      "connection with empty sections": {
        input: {},
        context: { connections: [{ sections: [] }] },
        assertData: [{ legs: [] }],
        assertTraces: 0,
      },
      "multiple connections and sections": {
        input: {},
        context: {
          connections: [
            {
              sections: [
                {
                  departure: { station: { id: "a", name: "alpha" } },
                  arrival: { station: { id: "b", name: "beta" } },
                },
                {
                  departure: { station: { id: "c", name: "gamma" } },
                  arrival: { station: { id: "d", name: "delta" } },
                },
              ],
            },
            {
              sections: [
                {
                  departure: { station: { id: "e", name: "epsilon" } },
                  arrival: { station: { id: "f", name: "zeta" } },
                },
              ],
            },
          ],
        },
        assertData: [
          {
            legs: [
              {
                origin: { station: { id: "a", name: "ALPHA" } },
                destination: { station: { id: "b", name: "BETA" } },
              },
              {
                origin: { station: { id: "c", name: "GAMMA" } },
                destination: { station: { id: "d", name: "DELTA" } },
              },
            ],
          },
          {
            legs: [
              {
                origin: { station: { id: "e", name: "EPSILON" } },
                destination: { station: { id: "f", name: "ZETA" } },
              },
            ],
          },
        ],
        assertTraces: 0,
      },
    },
  },
});
