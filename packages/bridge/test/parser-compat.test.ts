/**
 * Parser tests: validates parseBridge handles all Bridge DSL constructs.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBridgeChevrotain as parseBridge } from "../src/parser/parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..", "..");

function compat(label: string, text: string) {
  it(label, () => {
    const result = parseBridge(text);
    assert.ok(Array.isArray(result), "should return an array");
  });
}

describe("parser — syntax coverage", () => {
  compat("simple bridge with input/output", `version 1.4
bridge Query.getWeather {
  with input
  with output as o
  o.temp <- input.temp
}`);

  compat("tool with constant and pull wires", `version 1.4
tool hereapi from std.httpCall {
  .baseUrl = "https://geocode.search.hereapi.com/v1"
  .method = GET
}
tool hereapi.geocode from hereapi {
  .path = /geocode
  .q <- context.q
  with context
}`);

  compat("const with JSON object", `version 1.4
const fallbackGeo = { "lat": 0, "lon": 0 }`);

  compat("const with string value", `version 1.4
const myStr = "hello"`);

  compat("const with number value", `version 1.4
const myNum = 42`);

  compat("const with boolean value", `version 1.4
const myBool = true`);

  compat("const with null value", `version 1.4
const myNull = null`);

  compat("const with array value", `version 1.4
const myArr = ["a", "b", "c"]`);

  compat("force wire", `version 1.4
bridge Query.test {
  with input
  with output as o
  o.x <-! input.y
}`);

  compat("pipe chain", `version 1.4
bridge Query.test {
  with std.upperCase as uc
  with input
  with output as o
  o.name <- uc:input.name
}`);

  compat("null coalesce with literal", `version 1.4
bridge Query.test {
  with input
  with output as o
  with context
  o.x <- input.a || context.b || "fallback"
}`);

  compat("error fallback with literal", `version 1.4
bridge Query.test {
  with input
  with output as o
  with context
  o.x <- input.a ?? "error_val"
}`);

  compat("array mapping", `version 1.4
bridge Query.test {
  with std.upperCase as uc
  with input
  with output as o
  o.items <- input.items[] as item {
    .name <- item.name
    .id <- item.id
  }
}`);

  compat("define block and usage", `version 1.4
define myDef {
  with input as i
  with output as o
  with std.upperCase as uc
  o.name <- uc:i.name
}
bridge Query.test {
  with myDef as d
  with input
  with output as o
  d <- input
  o <- d
}`);

  compat("passthrough shorthand", `version 1.4
tool myTool from std.httpCall
bridge Query.test with myTool`);

  compat("tool with context alias", `version 1.4
tool myTool from std.httpCall {
  with context as ctx
  .apiKey <- ctx.apiKey
}`);

  compat("null + error coalesce combined", `version 1.4
bridge Query.test {
  with input
  with output as o
  with context
  o.x <- input.a || input.b ?? context.fallback
}`);

  compat("tool extends another tool", `version 1.4
tool base from std.httpCall {
  .baseUrl = "https://api.example.com"
}
tool base.search from base {
  .path = /search
}
tool base.detail from base {
  .path = /detail
}`);

  compat("multiple bridges", `version 1.4
tool api from std.httpCall {
  .baseUrl = "https://api.example.com"
}
bridge Query.first {
  with api as a
  with input
  with output as o
  a.q <- input.q
  o.result <- a.data
}
bridge Query.second {
  with api as a
  with input
  with output as o
  a.id <- input.id
  o.item <- a
}`);

  compat("nested dotted paths on tool wire", `version 1.4
tool myTool from std.httpCall {
  .headers.Authorization <- context.token
  with context
}`);

  compat("array index in source", `version 1.4
bridge Query.test {
  with input
  with output as o
  o.first <- input.items[0].name
}`);

  compat("on error constant", `version 1.4
tool myTool from std.httpCall {
  on error = { "error": true }
}`);

  compat("on error source", `version 1.4
tool myTool from std.httpCall {
  with context
  on error <- context.fallback
}`);

  compat("constant wire in bridge", `version 1.4
bridge Query.test {
  with output as o
  o.fixed = "hello world"
}`);

  compat("with const in bridge", `version 1.4
bridge Query.test {
  with const as c
  with output as o
  o.val <- c.myKey
}`);

  compat("bridge wire to handle root (no path)", `version 1.4
bridge Query.test {
  with std.httpCall as api
  with input
  with output as o
  api <- input
  o <- api
}`);

  compat("define with constant wire", `version 1.4
define myDef {
  with input as i
  with output as o
  o.tag = "computed"
}`);

  compat("element wire with coalesce", `version 1.4
bridge Query.test {
  with input
  with output as o
  o.items <- input.items[] as item {
    .name <- item.name || "unknown"
  }
}`);

  compat("tool with const dep", `version 1.4
tool myTool from std.httpCall {
  with const as c
  .apiKey <- c.key
}`);

  compat("multiple pipe tools", `version 1.4
bridge Query.test {
  with std.upperCase as uc
  with std.lowerCase as lc
  with input
  with output as o
  o.name <- uc:lc:input.name
}`);

  compat("passthrough with dotted name", `version 1.4
tool std.httpCall from std.httpCall
bridge Query.test with std.httpCall`);
});

describe("parser — real .bridge files", () => {
  const bridgeFiles = [
    join(root, "examples/weather-api/Weather.bridge"),
    join(root, "examples/builtin-tools/builtin-tools.bridge"),
    join(__dirname, "property-search.bridge"),
  ];

  for (const filePath of bridgeFiles) {
    const name = filePath.split("/").slice(-2).join("/");
    it(name, () => {
      const text = readFileSync(filePath, "utf-8");
      const result = parseBridge(text);
      assert.ok(Array.isArray(result), "should return an array");
    });
  }
});

describe("parser — edge cases", () => {
  compat("hyphenated path in tool header", `version 1.4
tool sg from std.httpCall {
  .headers.x-message-id <- context.msgId
  with context
}`);

  compat("array index in source path", `version 1.4
bridge Query.test {
  with myTool as t
  with input
  with output as o
  t.q <- input.q
  o.lat <- t.items[0].position.lat
  o.lng <- t.items[0].position.lng
}`);

  compat("mutation type", `version 1.4
bridge Mutation.sendEmail {
  with myMailer as m
  with input
  with output as o
  m.to <- input.to
  m.subject <- input.subject
  o.status <- m.status
}`);

  compat("case-insensitive keywords", `version 1.4
Bridge Query.test {
  With Input
  With Output As o
  o.x <- input.y
}`);

  compat("tool with on error JSON", `version 1.4
tool myTool from std.httpCall {
  on error = { "lat": 0, "lon": 0 }
}`);

  compat("tool POST with headers", `version 1.4
tool myApi from std.httpCall {
  .baseUrl = "https://api.example.com"
  .method = POST
  .headers.Content-Type = "application/json"
  .headers.X-Custom = "static-value"
  with context as ctx
  .headers.Authorization <- ctx.token
}`);

  compat("error fallback ?? with number", `version 1.4
bridge Query.test {
  with myTool as t
  with input
  with output as o
  t.q <- input.q
  o.temp <- t.current_weather.temperature ?? 0.0
}`);

  compat("null coalesce + error fallback combined", `version 1.4
bridge Query.test {
  with myTool as t
  with otherTool as ot
  with input
  with output as o
  t.q <- input.q
  ot.q <- input.q
  o.name <- t.name || ot.name ?? "Unknown"
}`);

  compat("multiple tools in chain", `version 1.4
tool base from std.httpCall {
  .baseUrl = "https://api.example.com"
}
tool base.search from base {
  .path = /search
}
bridge Query.test {
  with base.search as s
  with input
  with output as o
  s.q <- input.query
  o.results <- s.items[0].title
}`);

  compat("tool with const dep and nested context", `version 1.4
tool authTool from std.httpCall {
  with const as c
  with context as ctx
  .apiKey <- c.apiKey
  .userToken <- ctx.auth.token
}`);
});