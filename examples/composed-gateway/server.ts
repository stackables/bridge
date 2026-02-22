/**
 * Composed Gateway Example
 *
 * Demonstrates three composability patterns in a single Yoga server:
 *
 *  1. Multiple schemas   — Weather + Quotes merged into one endpoint
 *  2. Multiple .bridge   — each schema has its own Bridge instructions;
 *                          they are concatenated and passed to a single
 *                          `bridgeTransform` call
 *  3. Hand-coded resolver — Mutation.saveQuote is plain TypeScript;
 *                          Bridge only takes over fields that have
 *                          matching `bridge` instructions
 */
import { createSchema, createYoga } from "graphql-yoga";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import {
  bridgeTransform,
  parseBridge,
  useBridgeTracing,
} from "@stackables/bridge";

// ── 1. Load schemas ──────────────────────────────────────────────────────

const weatherTypeDefs = readFileSync(
  new URL("../weather-api/Weather.graphql", import.meta.url),
  "utf-8",
);

const quotesTypeDefs = readFileSync(
  new URL("./Quotes.graphql", import.meta.url),
  "utf-8",
);

// ── 2. Load bridge instructions ──────────────────────────────────────────

const weatherInstructions = parseBridge(
  readFileSync(new URL("../weather-api/Weather.bridge", import.meta.url), "utf-8"),
);

const quotesInstructions = parseBridge(
  readFileSync(new URL("./Quotes.bridge", import.meta.url), "utf-8"),
);

// Concatenate — bridgeTransform matches by type+field, so instructions from
// different domains coexist without conflict.
const allInstructions = [...weatherInstructions, ...quotesInstructions];

// ── 3. In-memory store for the hand-coded mutation ───────────────────────

type SavedQuote = {
  id: string;
  text: string;
  author: string;
  savedAt: string;
};
const savedQuotes: SavedQuote[] = [];

// ── 4. Build schema ─────────────────────────────────────────────────────

// Merge type definitions from both domains.  GraphQL Yoga's createSchema
// accepts an array of SDL strings and merges them automatically.
const baseSchema = createSchema({
  typeDefs: [weatherTypeDefs, quotesTypeDefs],
  resolvers: {
    // Hand-coded resolver — no bridge instruction for this field, so
    // bridgeTransform will leave it untouched.
    Mutation: {
      saveQuote: (_root: any, args: { text: string; author: string }) => {
        const entry: SavedQuote = {
          id: String(savedQuotes.length + 1),
          text: args.text,
          author: args.author,
          savedAt: new Date().toISOString(),
        };
        savedQuotes.push(entry);
        return entry;
      },
    },
  },
});

// Apply bridge transform once — covers both Weather and Quotes.
// Fields without a matching bridge instruction (Mutation.saveQuote) are
// passed through to their original resolvers.
const schema = bridgeTransform(baseSchema, allInstructions, {
  trace: "full",
  logger: console,
});

// ── 5. Expose via Yoga ──────────────────────────────────────────────────

export const yoga = createYoga({
  schema,
  graphqlEndpoint: "*",
  plugins: [useBridgeTracing()],
});

// Export the saved quotes store so tests can inspect it
export { savedQuotes };

if (process.argv[1] === import.meta.filename) {
  createServer(yoga).listen(4000, () => {
    console.log("Composed gateway running at http://localhost:4000/graphql");
    console.log("");
    console.log("Try:");
    console.log('  Weather:  { getWeatherByName(cityName: "Paris") { city currentTemp } }');
    console.log("  Quote:    { randomQuote { text author } }");
    console.log('  Mutation: mutation { saveQuote(text: "Hello", author: "World") { id savedAt } }');
  });
}
