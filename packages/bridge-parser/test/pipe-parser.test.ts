import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  parseBridgeFormat as parseBridge,
  serializeBridge,
} from "../src/index.ts";

// ── Pipe operator parser tests ──────────────────────────────────────────────

describe("pipe operator – parser", () => {
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
    const bridgeText = `version 1.5
bridge Query.shout {
  with input as i
  with toUpper as tu
  with output as o

o.loud <- tu:i.text

}`;
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

  test("with <name> shorthand round-trips through serializer", () => {
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
    const instructions = parseBridge(bridgeText);
    const serialized = serializeBridge(instructions);
    assert.ok(serialized.includes("  with convertToEur\n"), "short with form");
    const reparsed = parseBridge(serialized);
    const reserialized = serializeBridge(reparsed);
    assert.equal(reserialized, serialized, "idempotent");
  });

  test("pipe forking serializes and round-trips correctly", () => {
    const bridgeText = `version 1.5
tool double from doubler


bridge Query.doubled {
  with double as d
  with input as i
  with output as o

o.a <- d:i.a
o.b <- d:i.b

}`;
    const instructions = parseBridge(bridgeText);
    const serialized = serializeBridge(instructions);
    assert.ok(serialized.includes("o.a <- d:i.a"), "first fork");
    assert.ok(serialized.includes("o.b <- d:i.b"), "second fork");
    const reparsed = parseBridge(serialized);
    const reserialized = serializeBridge(reparsed);
    assert.equal(reserialized, serialized, "idempotent");
  });

  test("named input field round-trips through serializer", () => {
    const bridgeText = `version 1.5
tool divide from divider


bridge Query.converted {
  with divide as dv
  with input as i
  with output as o

o.converted <- dv.dividend:i.amount
dv.divisor <- i.rate

}`;
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

  test("cache param round-trips through serializer", () => {
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
    const instructions = parseBridge(bridgeText);
    const serialized = serializeBridge(instructions);
    assert.ok(serialized.includes("cache = 60"), "cache param");
    const reparsed = parseBridge(serialized);
    const reserialized = serializeBridge(reparsed);
    assert.equal(reserialized, serialized, "idempotent");
  });
});
