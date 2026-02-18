import { buildHTTPExecutor } from "@graphql-tools/executor-http";
import { parse } from "graphql";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBridge } from "../src/bridge-format.js";
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
tool weatherApi httpCall
  with config
  baseUrl = "https://api.weather.test/v2"
  headers.apiKey <- config.weather.apiKey

tool weatherApi.current extends weatherApi
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
      config: { weather: { apiKey: "test-key-123" } },
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
tool base httpCall
  method = GET
  baseUrl = "https://default.test"

tool base.special extends base
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

// ── Config pull (end-to-end) ────────────────────────────────────────────────

describe("config pull", () => {
  const typeDefs = /* GraphQL */ `
    type Query {
      lookup(q: String!): LookupResult
    }
    type LookupResult {
      answer: String
    }
  `;

  const bridgeText = `
tool myapi httpCall
  with config
  baseUrl = "https://api.test"
  headers.Authorization <- config.myapi.token
  headers.X-Org <- config.myapi.orgId

tool myapi.lookup extends myapi
  method = GET
  path = /lookup

---

bridge Query.lookup
  with myapi.lookup as m
  with input as i

m.q <- i.q
answer <- m.result
`;

  test("config values are pulled into tool headers", async () => {
    let capturedInput: Record<string, any> = {};

    const httpCall = async (input: Record<string, any>) => {
      capturedInput = input;
      return { result: "42" };
    };

    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, {
      config: { myapi: { token: "Bearer secret", orgId: "org-99" } },
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
tool authService httpCall
  with config
  baseUrl = "https://auth.test"
  method = POST
  path = /token
  body.clientId <- config.auth.clientId
  body.secret <- config.auth.secret

tool mainApi httpCall
  with config
  with authService as auth
  baseUrl = "https://api.test"
  headers.Authorization <- auth.access_token

tool mainApi.getData extends mainApi
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
      config: { auth: { clientId: "client-1", secret: "s3cret" } },
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
