import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseBridgeFormat as parseBridge,
  serializeBridge,
} from "@stackables/bridge-parser";
import { forEachEngine } from "./utils/dual-run.ts";

// ── Missing tool error ──────────────────────────────────────────────────────

forEachEngine("missing tool", (run) => {
  test("throws when tool is not registered", async () => {
    await assert.rejects(() =>
      run(
        `version 1.5
bridge Query.hello {
  with unknown.api as u
  with input as i
  with output as o

u.name <- i.name
o.message <- u.greeting

}`,
        "Query.hello",
        { name: "world" },
        {},
      ),
    );
  });
});

// ── Extends chain (end-to-end) ──────────────────────────────────────────────

forEachEngine("extends chain", (run, { engine }) => {
  const bridgeText = `version 1.5
tool weatherApi from httpCall {
  with context
  .baseUrl = "https://api.weather.test/v2"
  .headers.apiKey <- context.weather.apiKey

}
tool weatherApi.current from weatherApi {
  .method = GET
  .path = /current

}

bridge Query.weather {
  with weatherApi.current as w
  with input as i
  with output as o

w.city <- i.city
o.temp <- w.temperature
o.city <- w.location.name

}`;

  test(
    "child inherits parent wires and calls httpCall",
    { skip: engine === "compiled" },
    async () => {
      let capturedInput: Record<string, any> = {};
      const httpCall = async (input: Record<string, any>) => {
        capturedInput = input;
        return { temperature: 22.5, location: { name: "Berlin" } };
      };

      const { data } = await run(
        bridgeText,
        "Query.weather",
        { city: "Berlin" },
        { httpCall },
        { context: { weather: { apiKey: "test-key-123" } } },
      );

      assert.equal(data.temp, 22.5);
      assert.equal(data.city, "Berlin");
      assert.equal(capturedInput.baseUrl, "https://api.weather.test/v2");
      assert.equal(capturedInput.method, "GET");
      assert.equal(capturedInput.path, "/current");
      assert.equal(capturedInput.headers?.apiKey, "test-key-123");
      assert.equal(capturedInput.city, "Berlin");
    },
  );

  test("child can override parent wire", async () => {
    let capturedInput: Record<string, any> = {};
    const bridgeWithOverride = `version 1.5
tool base from httpCall {
  .method = GET
  .baseUrl = "https://default.test"

}
tool base.special from base {
  .baseUrl = "https://override.test"
  .path = /data

}

bridge Query.weather {
  with base.special as b
  with input as i
  with output as o

b.city <- i.city
o.temp <- b.temperature
o.city <- b.location.name

}`;

    const httpCall = async (input: Record<string, any>) => {
      capturedInput = input;
      return { temperature: 15, location: { name: "Oslo" } };
    };

    const { data } = await run(
      bridgeWithOverride,
      "Query.weather",
      { city: "Oslo" },
      { httpCall },
    );

    assert.equal(data.temp, 15);
    assert.equal(capturedInput.baseUrl, "https://override.test");
    assert.equal(capturedInput.method, "GET");
    assert.equal(capturedInput.path, "/data");
  });
});

// ── Context pull (end-to-end) ───────────────────────────────────────────────

forEachEngine("context pull", (run, { engine }) => {
  test(
    "context values are pulled into tool headers",
    { skip: engine === "compiled" },
    async () => {
      let capturedInput: Record<string, any> = {};
      const httpCall = async (input: Record<string, any>) => {
        capturedInput = input;
        return { result: "42" };
      };

      const { data } = await run(
        `version 1.5
tool myapi from httpCall {
  with context
  .baseUrl = "https://api.test"
  .headers.Authorization <- context.myapi.token
  .headers.X-Org <- context.myapi.orgId

}
tool myapi.lookup from myapi {
  .method = GET
  .path = /lookup

}

bridge Query.lookup {
  with myapi.lookup as m
  with input as i
  with output as o

m.q <- i.q
o.answer <- m.result

}`,
        "Query.lookup",
        { q: "meaning of life" },
        { httpCall },
        { context: { myapi: { token: "Bearer secret", orgId: "org-99" } } },
      );

      assert.equal(data.answer, "42");
      assert.equal(capturedInput.headers?.Authorization, "Bearer secret");
      assert.equal(capturedInput.headers?.["X-Org"], "org-99");
      assert.equal(capturedInput.q, "meaning of life");
    },
  );
});

// ── Tool-to-tool dependency (end-to-end) ────────────────────────────────────

forEachEngine("tool-to-tool dependency", (run, { engine }) => {
  test(
    "auth tool is called before main API, token injected",
    { skip: engine === "compiled" },
    async () => {
      const calls: { name: string; input: Record<string, any> }[] = [];
      const httpCall = async (input: Record<string, any>) => {
        if (input.path === "/token") {
          calls.push({ name: "auth", input });
          return { access_token: "tok_abc" };
        }
        calls.push({ name: "main", input });
        return { payload: "secret-data" };
      };

      const { data } = await run(
        `version 1.5
tool authService from httpCall {
  with context
  .baseUrl = "https://auth.test"
  .method = POST
  .path = /token
  .body.clientId <- context.auth.clientId
  .body.secret <- context.auth.secret

}
tool mainApi from httpCall {
  with context
  with authService as auth
  .baseUrl = "https://api.test"
  .headers.Authorization <- auth.access_token

}
tool mainApi.getData from mainApi {
  .method = GET
  .path = /data

}

bridge Query.data {
  with mainApi.getData as m
  with input as i
  with output as o

m.id <- i.id
o.value <- m.payload

}`,
        "Query.data",
        { id: "x" },
        { httpCall },
        { context: { auth: { clientId: "client-1", secret: "s3cret" } } },
      );

      assert.equal(data.value, "secret-data");

      const authCall = calls.find((c) => c.name === "auth");
      assert.ok(authCall, "auth tool should be called");
      assert.equal(authCall.input.baseUrl, "https://auth.test");
      assert.equal(authCall.input.body?.clientId, "client-1");
      assert.equal(authCall.input.body?.secret, "s3cret");

      const mainCall = calls.find((c) => c.name === "main");
      assert.ok(mainCall, "main API tool should be called");
      assert.equal(mainCall.input.headers?.Authorization, "tok_abc");
      assert.equal(mainCall.input.id, "x");
    },
  );
});

// ── Tool-to-tool dependency: on error fallback ───────────────────────────────

forEachEngine(
  "tool-to-tool dependency: on error fallback",
  (run, { engine }) => {
    test(
      "on error JSON value used when dep tool throws",
      { skip: engine === "compiled" },
      async () => {
        const calls: string[] = [];
        const mockFn = async (input: Record<string, any>) => {
          if (!input.authToken) {
            calls.push("flakyAuth-throw");
            throw new Error("Auth service unreachable");
          }
          calls.push(`mainApi:${input.authToken}`);
          return { result: `token=${input.authToken}` };
        };

        const { data } = await run(
          `version 1.5
tool flakyAuth from mockFn {
  on error = {"token": "fallback-token"}
}
tool mainApi from mockFn {
  with flakyAuth as auth
  .authToken <- auth.token
}

bridge Query.fetch {
  with mainApi as m
  with output as o

o.status <- m.result

}`,
          "Query.fetch",
          {},
          { mockFn },
        );

        assert.ok(
          calls.includes("flakyAuth-throw"),
          "flakyAuth should have thrown",
        );
        assert.ok(
          calls.some((c) => c.startsWith("mainApi:")),
          "mainApi should have been called",
        );
        assert.equal(data.status, "token=fallback-token");
      },
    );
  },
);

// ── Pipe operator (end-to-end) ───────────────────────────────────────────────

forEachEngine("pipe operator", (run) => {
  const bridgeText = `version 1.5
bridge Query.shout {
  with input as i
  with toUpper as tu
  with output as o

o.loud <- tu:i.text

}`;

  test("pipes source through tool and maps result to output", async () => {
    let capturedInput: Record<string, any> = {};
    const toUpper = (input: Record<string, any>) => {
      capturedInput = input;
      return String(input.in).toUpperCase();
    };

    const { data } = await run(
      bridgeText,
      "Query.shout",
      { text: "hello world" },
      { toUpper },
    );
    assert.equal(data.loud, "HELLO WORLD");
    assert.equal(capturedInput.in, "hello world");
  });

  test("pipe fails when handle is not declared", () => {
    assert.throws(
      () =>
        parseBridge(`version 1.5
bridge Query.shout {
  with input as i
  with output as o

o.loud <- undeclared:i.text

}`),
      /Undeclared handle in pipe: "undeclared"/,
    );
  });

  test("serializer round-trips pipe syntax", () => {
    const instructions = parseBridge(bridgeText);
    const serialized = serializeBridge(instructions);
    assert.ok(serialized.includes("with toUpper as tu"), "handle declaration");
    assert.ok(serialized.includes("tu:"), "pipe operator");
    assert.ok(!serialized.includes("tu.in"), "no expanded in-wire");
    assert.ok(!serialized.includes("tu.out"), "no expanded out-wire");
    const reparsed = parseBridge(serialized);
    const reserialized = serializeBridge(reparsed);
    assert.equal(reserialized, serialized, "idempotent");
  });
});

// ── Pipe with extra tool params (end-to-end) ─────────────────────────────────

forEachEngine("pipe with extra tool params", (run, { engine }) => {
  const rates: Record<string, number> = { EUR: 100, GBP: 90 };
  const currencyConverter = (input: Record<string, any>) =>
    input.in / (rates[input.currency] ?? 100);

  const bridgeText = `version 1.5
tool convertToEur from currencyConverter {
  .currency = EUR

}

bridge Query.priceEur {
  with convertToEur
  with input as i
  with output as o

o.priceEur <- convertToEur:i.amount

}

bridge Query.priceAny {
  with convertToEur
  with input as i
  with output as o

convertToEur.currency <- i.currency
o.priceAny <- convertToEur:i.amount

}`;

  test("default currency from tool definition is used when not overridden", async () => {
    const { data } = await run(
      bridgeText,
      "Query.priceEur",
      { amount: 500 },
      { currencyConverter },
    );
    assert.equal(data.priceEur, 5);
  });

  test(
    "currency override from input takes precedence over tool default",
    { skip: engine === "compiled" },
    async () => {
      const { data } = await run(
        bridgeText,
        "Query.priceAny",
        { amount: 450, currency: "GBP" },
        { currencyConverter },
      );
      assert.equal(data.priceAny, 5);
    },
  );

  test("with <name> shorthand round-trips through serializer", () => {
    const instructions = parseBridge(bridgeText);
    const serialized = serializeBridge(instructions);
    assert.ok(serialized.includes("  with convertToEur\n"), "short with form");
    const reparsed = parseBridge(serialized);
    const reserialized = serializeBridge(reparsed);
    assert.equal(reserialized, serialized, "idempotent");
  });
});

// ── Pipe forking ──────────────────────────────────────────────────────────────

forEachEngine("pipe forking", (run) => {
  const doubler = (input: Record<string, any>) => input.in * 2;

  const bridgeText = `version 1.5
tool double from doubler


bridge Query.doubled {
  with double as d
  with input as i
  with output as o

o.a <- d:i.a
o.b <- d:i.b

}`;

  test("each pipe use is an independent call — both outputs are doubled", async () => {
    const { data } = await run(
      bridgeText,
      "Query.doubled",
      { a: 3, b: 7 },
      { doubler },
    );
    assert.equal(data.a, 6);
    assert.equal(data.b, 14);
  });

  test("pipe forking serializes and round-trips correctly", () => {
    const instructions = parseBridge(bridgeText);
    const serialized = serializeBridge(instructions);
    assert.ok(serialized.includes("o.a <- d:i.a"), "first fork");
    assert.ok(serialized.includes("o.b <- d:i.b"), "second fork");
    const reparsed = parseBridge(serialized);
    const reserialized = serializeBridge(reparsed);
    assert.equal(reserialized, serialized, "idempotent");
  });
});

// ── Named pipe input field ────────────────────────────────────────────────────

forEachEngine("pipe named input field", (run, { engine }) => {
  const divider = (input: Record<string, any>) =>
    input.dividend / input.divisor;

  const bridgeText = `version 1.5
tool divide from divider


bridge Query.converted {
  with divide as dv
  with input as i
  with output as o

o.converted <- dv.dividend:i.amount
dv.divisor <- i.rate

}`;

  test(
    "named input field routes value to correct parameter",
    { skip: engine === "compiled" },
    async () => {
      const { data } = await run(
        bridgeText,
        "Query.converted",
        { amount: 450, rate: 90 },
        { divider },
      );
      assert.equal(data.converted, 5);
    },
  );

  test("named input field round-trips through serializer", () => {
    const instructions = parseBridge(bridgeText);
    const serialized = serializeBridge(instructions);
    assert.ok(
      serialized.includes("converted <- dv.dividend:i.amount"),
      "named-field pipe token",
    );
    const reparsed = parseBridge(serialized);
    const reserialized = serializeBridge(reparsed);
    assert.equal(reserialized, serialized, "idempotent");
  });
});

// ── httpCall cache (end-to-end) ─────────────────────────────────────────────

forEachEngine("httpCall cache", (_run, { executeFn }) => {
  const bridgeText = `version 1.5
tool api from httpCall {
  .cache = 60
  .baseUrl = "http://mock"
  .method = GET
  .path = /search

}
bridge Query.lookup {
  with api as a
  with input as i
  with output as o

a.q <- i.q
o.answer <- a.value

}`;

  test("second identical call returns cached response (fetch called once)", async () => {
    let fetchCount = 0;
    const mockFetch = async (_url: string) => {
      fetchCount++;
      return { json: async () => ({ value: "hit-" + fetchCount }) } as Response;
    };

    const { createHttpCall } = await import("@stackables/bridge-stdlib");
    const httpCallTool = createHttpCall(mockFetch as any);

    const { parseBridgeFormat: parse } = await import(
      "@stackables/bridge-parser"
    );
    const document = parse(bridgeText);
    const doc = JSON.parse(JSON.stringify(document));

    const r1 = await executeFn({
      document: doc,
      operation: "Query.lookup",
      input: { q: "hello" },
      tools: { httpCall: httpCallTool },
    } as any);
    assert.equal((r1 as any).data.answer, "hit-1");

    const r2 = await executeFn({
      document: doc,
      operation: "Query.lookup",
      input: { q: "hello" },
      tools: { httpCall: httpCallTool },
    } as any);
    assert.equal(
      (r2 as any).data.answer,
      "hit-1",
      "should return cached value",
    );
    assert.equal(fetchCount, 1, "fetch should only be called once");
  });

  test("different query params are cached separately", async () => {
    let fetchCount = 0;
    const mockFetch = async (url: string) => {
      fetchCount++;
      const q = new URL(url).searchParams.get("q");
      return { json: async () => ({ value: q }) } as Response;
    };

    const { createHttpCall } = await import("@stackables/bridge-stdlib");
    const httpCallTool = createHttpCall(mockFetch as any);

    const { parseBridgeFormat: parse } = await import(
      "@stackables/bridge-parser"
    );
    const document = parse(bridgeText);
    const doc = JSON.parse(JSON.stringify(document));

    const r1 = await executeFn({
      document: doc,
      operation: "Query.lookup",
      input: { q: "A" },
      tools: { httpCall: httpCallTool },
    } as any);
    const r2 = await executeFn({
      document: doc,
      operation: "Query.lookup",
      input: { q: "B" },
      tools: { httpCall: httpCallTool },
    } as any);

    assert.equal((r1 as any).data.answer, "A");
    assert.equal((r2 as any).data.answer, "B");
    assert.equal(fetchCount, 2, "different params should each call fetch");
  });

  test("cache param round-trips through serializer", () => {
    const instructions = parseBridge(bridgeText);
    const serialized = serializeBridge(instructions);
    assert.ok(serialized.includes("cache = 60"), "cache param");
    const reparsed = parseBridge(serialized);
    const reserialized = serializeBridge(reparsed);
    assert.equal(reserialized, serialized, "idempotent");
  });
});
