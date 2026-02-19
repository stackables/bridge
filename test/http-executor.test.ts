import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createHttpCall } from "../src/tools/http-call.js";

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
    return { json: async () => response } as Response;
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
      return { json: async () => ({}) } as Response;
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
      return { json: async () => ({}) } as Response;
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
      return { json: async () => ({}) } as Response;
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
