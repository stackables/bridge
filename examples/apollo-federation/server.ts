/**
 * Apollo Federation subgraph example.
 *
 * Uses @apollo/subgraph to build a federation-ready schema,
 * then applies bridgeTransform to wire up the resolvers.
 *
 * Demonstrates replacing the built-in httpCall with a custom
 * implementation (e.g. for logging, caching, or auth injection).
 *
 * Install:
 *   pnpm add @apollo/server @apollo/subgraph graphql
 */

import { ApolloServer } from "@apollo/server";
import { startStandaloneServer } from "@apollo/server/standalone";
import { buildSubgraphSchema } from "@apollo/subgraph";
import { parse } from "graphql";
import { readFileSync } from "node:fs";
import { bridgeTransform, parseBridge } from "../../src/index.js";
import type { ToolCallFn } from "../../src/types.js";

const typeDefs = readFileSync(
  new URL("./Geocode.graphql", import.meta.url),
  "utf-8",
);
const instructions = parseBridge(
  readFileSync(new URL("./hereapi.bridge", import.meta.url), "utf-8"),
);

// ── Custom httpCall: drop-in replacement for the built-in ────────────
//
// The bridge file says `tool hereapi httpCall` — the engine calls
// whatever function is registered under the name "httpCall".
// Override it to add logging, caching, retries, or anything else.

const httpCall: ToolCallFn = async (input) => {
  const {
    baseUrl = "",
    method = "GET",
    path = "",
    headers = {},
    ...rest
  } = input;

  const url = new URL(baseUrl + path);
  if (method === "GET") {
    for (const [k, v] of Object.entries(rest)) {
      if (v != null) url.searchParams.set(k, String(v));
    }
  }

  console.log(`→ ${method} ${url}`);
  const start = performance.now();

  const response = await fetch(url.toString(), {
    method,
    headers: headers as Record<string, string>,
    body: method !== "GET" ? JSON.stringify(rest) : undefined,
  });
  const data = await response.json();

  console.log(
    `← ${response.status} (${(performance.now() - start).toFixed(0)}ms)`,
  );
  return data as Record<string, any>;
};

// ── Schema + bridge ──────────────────────────────────────────────────

// Federation needs parsed SDL with directives
const federationTypeDefs = parse(`
    extend schema @link(url: "https://specs.apollo.dev/federation/v2.0", import: ["@key"])
    ${typeDefs}
`);

const baseSchema = buildSubgraphSchema({ typeDefs: federationTypeDefs });

// Pass the custom httpCall — it overrides the built-in one
const schema = bridgeTransform(baseSchema, instructions, {
  tools: { httpCall },
});

const server = new ApolloServer({
  schema,
  // Apollo Server passes context to resolvers — bridge reads context.config
  plugins: [
    {
      async requestDidStart() {
        return {
          async didResolveOperation(requestContext) {
            requestContext.contextValue.config = {
              hereapi: { apiKey: process.env.HEREAPI_KEY ?? "" },
            };
          },
        };
      },
    },
  ],
});

const { url } = await startStandaloneServer(server, { listen: { port: 4001 } });
console.log(`Geocode subgraph running at ${url}`);
