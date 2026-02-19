import { buildHTTPExecutor } from "@graphql-tools/executor-http";
import { parse } from "graphql";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBridge, serializeBridge } from "../src/bridge-format.js";
import { createGateway } from "./_gateway.js";

// ── Missing tool error ──────────────────────────────────────────────────────

describe("missing tool", () => {
  const typeDefs = /* GraphQL */ `
    type Query {
      hello(name: String!): Greeting
    }
    type Greeting {
      message: String
    }
  `;

  const bridgeText = `
bridge Query.hello
  with unknown.api as u
  with input as i

u.name <- i.name
message <- u.greeting
`;

  test("throws when tool is not registered", async () => {
    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, { tools: {} });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ hello(name: "world") { message } }`),
    });

    assert.ok(result.errors, "expected errors");
    assert.ok(result.errors.length > 0, "expected at least one error");
  });
});

// ── Extends chain (end-to-end) ──────────────────────────────────────────────

describe("extends chain", () => {
  const typeDefs = /* GraphQL */ `
    type Query {
      weather(city: String!): Weather
    }
    type Weather {
      temp: Float
      city: String
    }
  `;

  // Parent tool sets baseUrl + auth header.
  // Child inherits those and adds method + path.
  // Bridge wires city from input.
  const bridgeText = `
extend httpCall as weatherApi
  with context
  baseUrl = "https://api.weather.test/v2"
  headers.apiKey <- context.weather.apiKey

extend weatherApi as weatherApi.current
  method = GET
  path = /current

---

bridge Query.weather
  with weatherApi.current as w
  with input as i

w.city <- i.city
temp <- w.temperature
city <- w.location.name
`;

  test("child inherits parent wires and calls httpCall", async () => {
    let capturedInput: Record<string, any> = {};

    // Custom httpCall that captures the fully-built input
    const httpCall = async (input: Record<string, any>) => {
      capturedInput = input;
      return { temperature: 22.5, location: { name: "Berlin" } };
    };

    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, {
      context: { weather: { apiKey: "test-key-123" } },
      tools: { httpCall },
    });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ weather(city: "Berlin") { temp city } }`),
    });

    // Verify the output
    assert.equal(result.data.weather.temp, 22.5);
    assert.equal(result.data.weather.city, "Berlin");

    // Verify the merged input sent to httpCall
    assert.equal(capturedInput.baseUrl, "https://api.weather.test/v2");
    assert.equal(capturedInput.method, "GET");
    assert.equal(capturedInput.path, "/current");
    assert.equal(capturedInput.headers?.apiKey, "test-key-123");
    assert.equal(capturedInput.city, "Berlin");
  });

  test("child can override parent wire", async () => {
    let capturedInput: Record<string, any> = {};

    const bridgeWithOverride = `
extend httpCall as base
  method = GET
  baseUrl = "https://default.test"

extend base as base.special
  baseUrl = "https://override.test"
  path = /data

---

bridge Query.weather
  with base.special as b
  with input as i

b.city <- i.city
temp <- b.temperature
city <- b.location.name
`;

    const httpCall = async (input: Record<string, any>) => {
      capturedInput = input;
      return { temperature: 15, location: { name: "Oslo" } };
    };

    const instructions = parseBridge(bridgeWithOverride);
    const gateway = createGateway(typeDefs, instructions, {
      tools: { httpCall },
    });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ weather(city: "Oslo") { temp } }`),
    });

    assert.equal(result.data.weather.temp, 15);
    // Child's baseUrl overrides parent's
    assert.equal(capturedInput.baseUrl, "https://override.test");
    assert.equal(capturedInput.method, "GET"); // inherited
    assert.equal(capturedInput.path, "/data");
  });
});

// ── Context pull (end-to-end) ───────────────────────────────────────────────

describe("context pull", () => {
  const typeDefs = /* GraphQL */ `
    type Query {
      lookup(q: String!): LookupResult
    }
    type LookupResult {
      answer: String
    }
  `;

  const bridgeText = `
extend httpCall as myapi
  with context
  baseUrl = "https://api.test"
  headers.Authorization <- context.myapi.token
  headers.X-Org <- context.myapi.orgId

extend myapi as myapi.lookup
  method = GET
  path = /lookup

---

bridge Query.lookup
  with myapi.lookup as m
  with input as i

m.q <- i.q
answer <- m.result
`;

  test("context values are pulled into tool headers", async () => {
    let capturedInput: Record<string, any> = {};

    const httpCall = async (input: Record<string, any>) => {
      capturedInput = input;
      return { result: "42" };
    };

    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, {
      context: { myapi: { token: "Bearer secret", orgId: "org-99" } },
      tools: { httpCall },
    });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ lookup(q: "meaning of life") { answer } }`),
    });

    assert.equal(result.data.lookup.answer, "42");
    assert.equal(capturedInput.headers?.Authorization, "Bearer secret");
    assert.equal(capturedInput.headers?.["X-Org"], "org-99");
    assert.equal(capturedInput.q, "meaning of life");
  });
});

// ── Tool-to-tool dependency (end-to-end) ────────────────────────────────────

describe("tool-to-tool dependency", () => {
  const typeDefs = /* GraphQL */ `
    type Query {
      data(id: String!): SecureData
    }
    type SecureData {
      value: String
    }
  `;

  // authService is called first, its output is used in mainApi's headers
  const bridgeText = `
extend httpCall as authService
  with context
  baseUrl = "https://auth.test"
  method = POST
  path = /token
  body.clientId <- context.auth.clientId
  body.secret <- context.auth.secret

extend httpCall as mainApi
  with context
  with authService as auth
  baseUrl = "https://api.test"
  headers.Authorization <- auth.access_token

extend mainApi as mainApi.getData
  method = GET
  path = /data

---

bridge Query.data
  with mainApi.getData as m
  with input as i

m.id <- i.id
value <- m.payload
`;

  test("auth tool is called before main API, token injected", async () => {
    const calls: { name: string; input: Record<string, any> }[] = [];

    // httpCall sees both the auth call and the main API call
    const httpCall = async (input: Record<string, any>) => {
      if (input.path === "/token") {
        calls.push({ name: "auth", input });
        return { access_token: "tok_abc" };
      }
      calls.push({ name: "main", input });
      return { payload: "secret-data" };
    };

    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, {
      context: { auth: { clientId: "client-1", secret: "s3cret" } },
      tools: { httpCall },
    });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ data(id: "x") { value } }`),
    });

    assert.equal(result.data.data.value, "secret-data");

    // Auth was called
    const authCall = calls.find((c) => c.name === "auth");
    assert.ok(authCall, "auth tool should be called");
    assert.equal(authCall.input.baseUrl, "https://auth.test");
    assert.equal(authCall.input.body?.clientId, "client-1");
    assert.equal(authCall.input.body?.secret, "s3cret");

    // Main API got the token from auth
    const mainCall = calls.find((c) => c.name === "main");
    assert.ok(mainCall, "main API tool should be called");
    assert.equal(mainCall.input.headers?.Authorization, "tok_abc");
    assert.equal(mainCall.input.id, "x");
  });
});

// ── Pipe operator (end-to-end) ───────────────────────────────────────────────
//
// `result <- toolName|source` is shorthand for:
//   (implicit) with toolName as $handle
//   $handle.in  <- source
//   result      <- $handle.out

describe("pipe operator", () => {
  const typeDefs = /* GraphQL */ `
    type Query {
      shout(text: String!): ShoutResult
    }
    type ShoutResult {
      loud: String
    }
  `;

  // The pipe tool receives { in: value } and returns { out: transformed }
  const bridgeText = `
bridge Query.shout
  with input as i
  with toUpper as tu

loud <- tu|i.text
`;

  test("pipes source through tool and maps result to output", async () => {
    let capturedInput: Record<string, any> = {};

    const toUpper = (input: Record<string, any>) => {
      capturedInput = input;
      return String(input.in).toUpperCase();
    };

    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, {
      tools: { toUpper },
    });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ shout(text: "hello world") { loud } }`),
    });

    assert.equal(result.data.shout.loud, "HELLO WORLD");
    assert.equal(capturedInput.in, "hello world");
  });

  test("pipe fails when handle is not declared", () => {
    const badBridge = `
bridge Query.shout
  with input as i

loud <- undeclared|i.text
`;
    assert.throws(
      () => parseBridge(badBridge),
      /Undeclared handle in pipe: "undeclared"/,
    );
  });

  test("serializer round-trips pipe syntax", () => {
    const instructions = parseBridge(bridgeText);
    const serialized = serializeBridge(instructions);
    // The declared handle must still appear in the with block
    assert.ok(serialized.includes("with toUpper as tu"), "handle declaration must appear in header");
    // The body should use the pipe operator (not two explicit wires)
    assert.ok(serialized.includes("tu|"), "serialized output should use pipe operator");
    assert.ok(!serialized.includes("tu.in"), "expanded in-wire should not appear");
    assert.ok(!serialized.includes("tu.out"), "expanded out-wire should not appear");
    // Parse → serialize → parse should be idempotent
    const reparsed = parseBridge(serialized);
    const reserialized = serializeBridge(reparsed);
    assert.equal(reserialized, serialized, "parseBridge(serializeBridge(x)) should be idempotent");
  });
});

// ── Pipe with extra tool params (end-to-end) ─────────────────────────────────
//
// Demonstrates a pipe-stage tool that has additional input fields beyond `in`.
// Those fields can be:
//   a) set as constants in the tool definition          → default values
//   b) wired from bridge input in the bridge body       → per-call override
//
// Tool shape:  { in: number, currency: string }  →  { out: number }

describe("pipe with extra tool params", () => {
  const typeDefs = /* GraphQL */ `
    type Query {
      priceEur(amount: Float!): Float
      priceAny(amount: Float!, currency: String!): Float
    }
  `;

  // Fictional exchange: divide by 100 for EUR, divide by 90 for GBP
  const rates: Record<string, number> = { EUR: 100, GBP: 90 };

  const currencyConverter = (input: Record<string, any>) =>
    input.in / (rates[input.currency] ?? 100);

  // ── Tool block ──────────────────────────────────────────────────────────
  // `currency = EUR` bakes a default.  The `with convertToEur` shorthand
  // (no `as`) uses the tool name itself as the handle.
  const bridgeText = `
extend currencyConverter as convertToEur
  currency = EUR

---

bridge Query.priceEur
  with convertToEur
  with input as i

priceEur <- convertToEur|i.amount

---

bridge Query.priceAny
  with convertToEur
  with input as i

convertToEur.currency <- i.currency
priceAny <- convertToEur|i.amount
`;

  function makeExecutor() {
    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, {
      tools: { currencyConverter },
    });
    return buildHTTPExecutor({ fetch: gateway.fetch as any });
  }

  test("default currency from tool definition is used when not overridden", async () => {
    const executor = makeExecutor();
    const result: any = await executor({
      document: parse(`{ priceEur(amount: 500) }`),
    });
    assert.equal(result.data.priceEur, 5);       // 500 / 100
  });

  test("currency override from input takes precedence over tool default", async () => {
    const executor = makeExecutor();
    const result: any = await executor({
      document: parse(`{ priceAny(amount: 450, currency: "GBP") }`),
    });
    assert.equal(result.data.priceAny, 5);       // 450 / 90
  });

  test("with <name> shorthand round-trips through serializer", () => {
    const instructions = parseBridge(bridgeText);
    const serialized = serializeBridge(instructions);
    // Short form must survive the round-trip
    assert.ok(serialized.includes("  with convertToEur\n"), "short with form should be preserved");
    const reparsed = parseBridge(serialized);
    const reserialized = serializeBridge(reparsed);
    assert.equal(reserialized, serialized, "should be idempotent");
  });
});

// ── Pipe forking ──────────────────────────────────────────────────────────────
//
// Each use of `<- handle|source` in a bridge is an INDEPENDENT tool call:
//   a <- c|i.a
//   b <- c|i.b
// is equivalent to two separate instances of tool `c`, each receiving its own
// input and producing its own output independently.

describe("pipe forking", () => {
  const typeDefs = /* GraphQL */ `
    type Query {
      doubled(a: Float!, b: Float!): Doubled
    }
    type Doubled {
      a: Float
      b: Float
    }
  `;

  // Simple doubler tool  {in: number} → number
  const doubler = (input: Record<string, any>) => input.in * 2;

  const bridgeText = `
extend doubler as double

---

bridge Query.doubled
  with double as d
  with input as i

doubled.a <- d|i.a
doubled.b <- d|i.b
`;

  function makeExecutor() {
    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, {
      tools: { doubler },
    });
    return buildHTTPExecutor({ fetch: gateway.fetch as any });
  }

  test("each pipe use is an independent call — both outputs are doubled", async () => {
    const executor = makeExecutor();
    const result: any = await executor({
      document: parse(`{ doubled(a: 3, b: 7) { a b } }`),
    });
    assert.equal(result.data.doubled.a, 6);   // 3 * 2
    assert.equal(result.data.doubled.b, 14);  // 7 * 2
  });

  test("pipe forking serializes and round-trips correctly", () => {
    const instructions = parseBridge(bridgeText);
    const serialized = serializeBridge(instructions);
    assert.ok(serialized.includes("doubled.a <- d|i.a"), "first fork serialized");
    assert.ok(serialized.includes("doubled.b <- d|i.b"), "second fork serialized");
    const reparsed = parseBridge(serialized);
    const reserialized = serializeBridge(reparsed);
    assert.equal(reserialized, serialized, "should be idempotent");
  });
});

// ── Named pipe input field ────────────────────────────────────────────────────
//
// Syntax: `target <- handle.field|source`
// The field name after the dot sets the input field on the pipe stage (default
// is `in`).  This lets you route a value to a specific parameter of the tool.

describe("pipe named input field", () => {
  const typeDefs = /* GraphQL */ `
    type Query {
      converted(amount: Float!, rate: Float!): Float
    }
  `;

  // Divider tool: { dividend: number, divisor: number } → number
  const divider = (input: Record<string, any>) => input.dividend / input.divisor;

  const bridgeText = `
extend divider as divide

---

bridge Query.converted
  with divide as dv
  with input as i

converted <- dv.dividend|i.amount
dv.divisor <- i.rate
`;

  function makeExecutor() {
    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, {
      tools: { divider },
    });
    return buildHTTPExecutor({ fetch: gateway.fetch as any });
  }

  test("named input field routes value to correct parameter", async () => {
    const executor = makeExecutor();
    const result: any = await executor({
      document: parse(`{ converted(amount: 450, rate: 90) }`),
    });
    assert.equal(result.data.converted, 5);   // 450 / 90
  });

  test("named input field round-trips through serializer", () => {
    const instructions = parseBridge(bridgeText);
    const serialized = serializeBridge(instructions);
    assert.ok(
      serialized.includes("converted <- dv.dividend|i.amount"),
      "named-field pipe token serialized correctly",
    );
    const reparsed = parseBridge(serialized);
    const reserialized = serializeBridge(reparsed);
    assert.equal(reserialized, serialized, "should be idempotent");
  });
});
