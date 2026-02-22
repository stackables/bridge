/**
 * Travel Server Example — Dynamic Routing with Header-Based Slice Selection
 *
 * Demonstrates:
 *  1. Nested array-in-array mapping — journeys[] containing legs[],
 *     each with explicit field remapping in the .bridge file
 *  2. Dynamic routing — an `x-provider` header selects between the
 *     Deutsche Bahn (DB) and Swiss Federal Railways (SBB) bridge slices
 *  3. Both slices map different REST APIs onto the exact same GraphQL
 *     schema, so consumers get a unified interface regardless of provider
 */
import { createSchema, createYoga } from "graphql-yoga";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import {
  bridgeTransform,
  parseBridge,
  useBridgeTracing,
} from "@stackables/bridge";

// ── 1. Load shared GraphQL schema ────────────────────────────────────────

const typeDefs = readFileSync(
  new URL("./TravelSearch.graphql", import.meta.url),
  "utf-8",
);

// ── 2. Parse both bridge slices at startup ───────────────────────────────

const dbInstructions = parseBridge(
  readFileSync(new URL("./db.bridge", import.meta.url), "utf-8"),
);

const sbbInstructions = parseBridge(
  readFileSync(new URL("./sbb.bridge", import.meta.url), "utf-8"),
);

// ── 3. Dynamic router: select slice based on x-provider header ───────────

const schema = bridgeTransform(
  createSchema({ typeDefs }),
  (context) => {
    const provider = context.provider ?? "db";
    return provider === "sbb" ? sbbInstructions : dbInstructions;
  },
  { trace: true },
);

// ── 4. Yoga server ───────────────────────────────────────────────────────

export const yoga = createYoga({
  schema,
  graphqlEndpoint: "*",
  plugins: [useBridgeTracing()],
  context: ({ request }) => ({
    provider: request.headers.get("x-provider") ?? "db",
  }),
});

if (process.argv[1] === import.meta.filename) {
  createServer(yoga).listen(4000, () => {
    console.log("Travel server running at http://localhost:4000/graphql");
    console.log("  Use header x-provider: db  (default) for Deutsche Bahn");
    console.log("  Use header x-provider: sbb for Swiss Federal Railways");
  });
}
