import assert from "node:assert/strict";
import test from "node:test";
import { GraphQLSchemaObserver } from "../utils/observed-schema/index.ts";

test("observed data can be turned into GraphQL SDL", () => {
  const schema = new GraphQLSchemaObserver();

  schema.add({
    operation: "Query.weather",
    input: {
      days: 3,
      flags: {
        metric: true,
      },
      zip: "8001",
    },
    output: {
      advisory: null,
      current: {
        code: "sun",
        temp: 21.5,
      },
      forecast: [
        { day: "Mon", high: 24 },
        { day: "Tue", high: 22 },
      ],
    },
  });

  schema.add({
    operation: "Query.weather",
    input: {
      days: 5,
      flags: {
        lang: "en",
        metric: true,
      },
      zip: "1000",
    },
    output: {
      advisory: "umbrella",
      current: {
        code: "rain",
        temp: 18,
      },
      forecast: [],
    },
  });

  schema.add({
    operation: "Mutation.scores",
    input: { id: "a" },
    output: [1, 2],
  });

  schema.add({
    operation: "Mutation.scores",
    input: { id: "b" },
    output: [1.5],
  });

  assert.equal(
    schema.toSDL(),
    [
      "type Query {",
      "  weather(days: Int!, flags: QueryWeatherFlagsInput!, zip: String!): QueryWeatherResult!",
      "}",
      "",
      "type Mutation {",
      "  scores(id: String!): [Float!]!",
      "}",
      "",
      "input QueryWeatherFlagsInput {",
      "  lang: String",
      "  metric: Boolean!",
      "}",
      "",
      "type QueryWeatherResult {",
      "  advisory: String",
      "  current: QueryWeatherResultCurrent!",
      "  forecast: [QueryWeatherResultForecast!]!",
      "}",
      "",
      "type QueryWeatherResultCurrent {",
      "  code: String!",
      "  temp: Float!",
      "}",
      "",
      "type QueryWeatherResultForecast {",
      "  day: String!",
      "  high: Int!",
      "}",
      "",
    ].join("\n"),
  );
});
