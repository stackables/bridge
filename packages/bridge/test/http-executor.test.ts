import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createHttpCall, parseCacheTTL } from "../src/tools/http-call.js";
import type { CacheStore } from "../src/types.js";

/** Creates a mock Response with optional headers. */
function mockResponse(data: any, headers?: Record<string, string>): Response {
  const h = new Headers(headers);
  return { json: async () => data, headers: h } as unknown as Response;
}

function mockFetch(expectedUrl: string, expectedOptions: any, response: any) {
  return async (url: string, options: any) => {
    assert.equal(url, expectedUrl);
    if (expectedOptions.method)
      assert.equal(options.method, expectedOptions.method);
    if (expectedOptions.headers) {
      for (const [key, value] of Object.entries(expectedOptions.headers)) {
        assert.equal(options.headers[key], value);
      }
    }
    if (expectedOptions.body) assert.equal(options.body, expectedOptions.body);
    return mockResponse(response);
  };
}

describe("createHttpCall", () => {
  test("GET: builds URL with query params and headers", async () => {
    const fetch = mockFetch(
      "https://geocode.search.hereapi.com/v1/geocode?q=Berlin&limit=10",
      { method: "GET", headers: { apiKey: "test-api-key-123" } },
      { items: [{ title: "Berlin" }] },
    );

    const httpCall = createHttpCall(fetch as any);
    const result = await httpCall({
      baseUrl: "https://geocode.search.hereapi.com/v1",
      method: "GET",
      path: "/geocode",
      headers: { apiKey: "test-api-key-123" },
      q: "Berlin",
      limit: "10",
    });

    assert.deepStrictEqual(result, { items: [{ title: "Berlin" }] });
  });

  test("POST: sends JSON body and merges headers", async () => {
    const fetch = mockFetch(
      "https://api.sendgrid.com/v3/mail/send",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer sg_test_token",
          "X-Custom": "static-value",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to: "alice@example.com",
          from: "bob@example.com",
          subject: "Hello",
          content: "Hi there",
        }),
      },
      { statusCode: 202 },
    );

    const httpCall = createHttpCall(fetch as any);
    const result = await httpCall({
      baseUrl: "https://api.sendgrid.com/v3",
      method: "POST",
      path: "/mail/send",
      headers: {
        Authorization: "Bearer sg_test_token",
        "X-Custom": "static-value",
      },
      to: "alice@example.com",
      from: "bob@example.com",
      subject: "Hello",
      content: "Hi there",
    });

    assert.deepStrictEqual(result, { statusCode: 202 });
  });

  test("GET: omits null/undefined query params", async () => {
    const fetch = mockFetch(
      "https://geocode.search.hereapi.com/v1/geocode?q=Berlin",
      { method: "GET" },
      { items: [] },
    );

    const httpCall = createHttpCall(fetch as any);
    await httpCall({
      baseUrl: "https://geocode.search.hereapi.com/v1",
      method: "GET",
      path: "/geocode",
      q: "Berlin",
      limit: undefined,
    });
  });

  test("default method is GET", async () => {
    let capturedMethod = "";
    const fetch = async (_url: string, options: any) => {
      capturedMethod = options.method;
      return mockResponse({});
    };

    const httpCall = createHttpCall(fetch as any);
    await httpCall({
      baseUrl: "https://example.com",
      path: "/test",
      q: "hello",
    });

    assert.equal(capturedMethod, "GET");
  });

  test("headers passed through correctly", async () => {
    let capturedHeaders: Record<string, string> = {};
    const fetch = async (_url: string, options: any) => {
      capturedHeaders = options.headers;
      return mockResponse({});
    };

    const httpCall = createHttpCall(fetch as any);
    await httpCall({
      baseUrl: "https://example.com",
      method: "GET",
      path: "/test",
      headers: { apiKey: "test-key", "X-Custom": "static-value" },
      q: "test",
    });

    assert.equal(capturedHeaders.apiKey, "test-key");
    assert.equal(capturedHeaders["X-Custom"], "static-value");
  });

  test("nested input objects work with POST", async () => {
    let capturedBody = "";
    const fetch = async (_url: string, options: any) => {
      capturedBody = options.body;
      return mockResponse({});
    };

    const httpCall = createHttpCall(fetch as any);
    await httpCall({
      baseUrl: "https://example.com",
      method: "POST",
      path: "/send",
      headers: {},
      personalizations: [{ to: [{ email: "a@b.com" }] }],
      subject: "Hello",
    });

    const parsed = JSON.parse(capturedBody);
    assert.deepStrictEqual(parsed.personalizations, [
      { to: [{ email: "a@b.com" }] },
    ]);
    assert.equal(parsed.subject, "Hello");
  });
});

// ── Cache behaviour ──────────────────────────────────────────────────────────

/** Counting fetch mock — tracks call count, supports response headers. */
function countingFetch(data: any, responseHeaders?: Record<string, string>) {
  let calls = 0;
  const fetch = async (_url: string, _options: any) => {
    calls++;
    return mockResponse(data, responseHeaders);
  };
  return { fetch: fetch as any, getCalls: () => calls };
}

describe("parseCacheTTL", () => {
  test("max-age is parsed", () => {
    const r = mockResponse({}, { "cache-control": "public, max-age=300" });
    assert.equal(parseCacheTTL(r), 300);
  });

  test("s-maxage takes priority over max-age", () => {
    const r = mockResponse({}, { "cache-control": "public, max-age=60, s-maxage=600" });
    assert.equal(parseCacheTTL(r), 600);
  });

  test("no-store returns 0", () => {
    const r = mockResponse({}, { "cache-control": "no-store" });
    assert.equal(parseCacheTTL(r), 0);
  });

  test("no-cache returns 0", () => {
    const r = mockResponse({}, { "cache-control": "no-cache, max-age=300" });
    assert.equal(parseCacheTTL(r), 0);
  });

  test("Expires header used when no Cache-Control", () => {
    const future = new Date(Date.now() + 120_000).toUTCString();
    const r = mockResponse({}, { expires: future });
    const ttl = parseCacheTTL(r);
    assert.ok(ttl >= 118 && ttl <= 121, `expected ~120, got ${ttl}`);
  });

  test("past Expires returns 0", () => {
    const r = mockResponse({}, { expires: "Thu, 01 Jan 1970 00:00:00 GMT" });
    assert.equal(parseCacheTTL(r), 0);
  });

  test("no headers returns 0", () => {
    const r = mockResponse({});
    assert.equal(parseCacheTTL(r), 0);
  });
});

describe("httpCall cache", () => {
  test("cache = 0 disables caching — every call hits fetch", async () => {
    const { fetch, getCalls } = countingFetch({ ok: true });
    const httpCall = createHttpCall(fetch);

    await httpCall({ baseUrl: "https://example.com", path: "/a", q: "1", cache: 0 });
    await httpCall({ baseUrl: "https://example.com", path: "/a", q: "1", cache: 0 });

    assert.equal(getCalls(), 2, "fetch should be called twice");
  });

  test("auto mode respects max-age header", async () => {
    const { fetch, getCalls } = countingFetch({ data: "fresh" }, { "cache-control": "max-age=60" });
    const httpCall = createHttpCall(fetch);

    // Default cache mode is auto
    const r1 = await httpCall({ baseUrl: "https://example.com", path: "/a", q: "x" });
    const r2 = await httpCall({ baseUrl: "https://example.com", path: "/a", q: "x" });

    assert.equal(getCalls(), 1, "second call should be cached");
    assert.deepStrictEqual(r1, { data: "fresh" });
    assert.deepStrictEqual(r2, { data: "fresh" });
  });

  test("auto mode does not cache when no cache headers present", async () => {
    const { fetch, getCalls } = countingFetch({ data: "fresh" });
    const httpCall = createHttpCall(fetch);

    await httpCall({ baseUrl: "https://example.com", path: "/a", q: "x" });
    await httpCall({ baseUrl: "https://example.com", path: "/a", q: "x" });

    assert.equal(getCalls(), 2, "no headers means no caching");
  });

  test("auto mode does not cache when no-store", async () => {
    const { fetch, getCalls } = countingFetch({ data: "secret" }, { "cache-control": "no-store" });
    const httpCall = createHttpCall(fetch);

    await httpCall({ baseUrl: "https://example.com", path: "/a", q: "x" });
    await httpCall({ baseUrl: "https://example.com", path: "/a", q: "x" });

    assert.equal(getCalls(), 2, "no-store should bypass cache");
  });

  test("explicit TTL overrides response headers", async () => {
    // Server says no-store but user says cache 60
    const { fetch, getCalls } = countingFetch({ data: "forced" }, { "cache-control": "no-store" });
    const httpCall = createHttpCall(fetch);

    await httpCall({ baseUrl: "https://example.com", path: "/a", q: "x", cache: 60 });
    await httpCall({ baseUrl: "https://example.com", path: "/a", q: "x", cache: 60 });

    assert.equal(getCalls(), 1, "explicit TTL should override no-store");
  });

  test("different params produce different cache keys", async () => {
    const { fetch, getCalls } = countingFetch({ result: 1 });
    const httpCall = createHttpCall(fetch);

    await httpCall({ baseUrl: "https://example.com", path: "/a", q: "Berlin", cache: 60 });
    await httpCall({ baseUrl: "https://example.com", path: "/a", q: "Paris", cache: 60 });

    assert.equal(getCalls(), 2, "different params should produce two fetches");
  });

  test("cache respects TTL expiry", async () => {
    let now = 1000000;
    const store = new Map<string, { value: any; expiry: number }>();
    const cache: CacheStore = {
      get(key) {
        const e = store.get(key);
        if (!e) return undefined;
        if (now > e.expiry) { store.delete(key); return undefined; }
        return e.value;
      },
      set(key, value, ttl) {
        store.set(key, { value, expiry: now + ttl * 1000 });
      },
    };

    const { fetch, getCalls } = countingFetch({ v: 1 });
    const httpCall = createHttpCall(fetch, cache);

    await httpCall({ baseUrl: "https://example.com", path: "/x", cache: 10 });
    assert.equal(getCalls(), 1);

    now += 5000;
    await httpCall({ baseUrl: "https://example.com", path: "/x", cache: 10 });
    assert.equal(getCalls(), 1, "should still be cached");

    now += 6000;
    await httpCall({ baseUrl: "https://example.com", path: "/x", cache: 10 });
    assert.equal(getCalls(), 2, "cache expired — should fetch again");
  });

  test("custom CacheStore is used instead of default", async () => {
    const ops: string[] = [];
    const custom: CacheStore = {
      async get(key) { ops.push(`get:${key}`); return undefined; },
      async set(key, _value, ttl) { ops.push(`set:${key}:${ttl}`); },
    };

    const { fetch } = countingFetch({ ok: true });
    const httpCall = createHttpCall(fetch, custom);

    await httpCall({ baseUrl: "https://example.com", path: "/z", cache: 120 });

    assert.ok(ops.some((o) => o.startsWith("get:")), "should call get on custom store");
    assert.ok(ops.some((o) => o.startsWith("set:") && o.endsWith(":120")), "should call set with TTL");
  });

  test("cache param is not sent as query param in GET requests", async () => {
    let capturedUrl = "";
    const fetch = async (url: string, _options: any) => {
      capturedUrl = url;
      return mockResponse({});
    };

    const httpCall = createHttpCall(fetch as any);
    await httpCall({ baseUrl: "https://example.com", path: "/a", q: "test", cache: 30 });

    assert.ok(!capturedUrl.includes("cache="), "cache should not appear in URL");
    assert.ok(capturedUrl.includes("q=test"), "q should be in URL");
  });

  test("POST body does not include cache param", async () => {
    let capturedBody = "";
    const fetch = async (_url: string, options: any) => {
      capturedBody = options.body;
      return mockResponse({});
    };

    const httpCall = createHttpCall(fetch as any);
    await httpCall({ baseUrl: "https://example.com", method: "POST", path: "/a", data: "hello", cache: 30 });

    const parsed = JSON.parse(capturedBody);
    assert.equal(parsed.data, "hello");
    assert.equal(parsed.cache, undefined, "cache should not be in body");
  });
});

// ── LRU eviction ─────────────────────────────────────────────────────────────

describe("LRU eviction", () => {
  test("evicts oldest entry when capacity exceeded", async () => {
    let fetchCount = 0;
    const fetch = async (url: string, _opts: any) => {
      fetchCount++;
      return mockResponse({ url });
    };

    // Use lru-cache with max 2 entries
    const { LRUCache } = await import("lru-cache");
    const lruStore = new LRUCache<string, any>({ max: 2 });
    const cache: CacheStore = {
      get(key) { return lruStore.get(key); },
      set(key, value, ttl) { if (ttl > 0) lruStore.set(key, value, { ttl: ttl * 1000 }); },
    };

    const httpCall = createHttpCall(fetch as any, cache);

    // Fill cache: A then B (2 slots full)
    await httpCall({ baseUrl: "https://example.com", path: "/a", cache: 300 });
    await httpCall({ baseUrl: "https://example.com", path: "/b", cache: 300 });
    assert.equal(fetchCount, 2);

    // A and B are cached
    await httpCall({ baseUrl: "https://example.com", path: "/a", cache: 300 });
    await httpCall({ baseUrl: "https://example.com", path: "/b", cache: 300 });
    assert.equal(fetchCount, 2, "both should be cached");

    // Adding C should evict A (least recently used — B was accessed more recently)
    await httpCall({ baseUrl: "https://example.com", path: "/c", cache: 300 });
    assert.equal(fetchCount, 3);

    // B should still be cached, A should be evicted
    await httpCall({ baseUrl: "https://example.com", path: "/b", cache: 300 });
    assert.equal(fetchCount, 3, "B should still be cached");

    await httpCall({ baseUrl: "https://example.com", path: "/a", cache: 300 });
    assert.equal(fetchCount, 4, "A should have been evicted and re-fetched");
  });
});
