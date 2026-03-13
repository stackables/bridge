import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { formatSnippet } from "./utils/formatter-test-utils.ts";

/**
 * ============================================================================
 * FULL EXAMPLE TEST CASES
 *
 * These tests show complete Bridge DSL snippets with expected formatting.
 * Edit these to define the canonical style.
 * ============================================================================
 */

describe("formatBridge - full examples", () => {
  test("simple tool declaration", () => {
    const input = `version 1.5
tool geo from std.httpCall`;
    const expected = `version 1.5

tool geo from std.httpCall
`;
    assert.equal(formatSnippet(input), expected);
  });

  test("tool with body", () => {
    const input = `version 1.5

tool geo from std.httpCall{
.baseUrl="https://example.com"
.method=GET
}`;
    const expected = `version 1.5

tool geo from std.httpCall {
  .baseUrl = "https://example.com"
  .method = GET
}
`;
    assert.equal(formatSnippet(input), expected);
  });

  test("bridge block with assignments", () => {
    const input = `version 1.5

bridge Query.test{
with input as i
with output as o
o.value<-i.value
}`;
    const expected = `version 1.5

bridge Query.test {
  with input as i
  with output as o

  o.value <- i.value
}
`;
    assert.equal(formatSnippet(input), expected);
  });

  test("define block", () => {
    const input = `define myHelper{
with input as i
o.x<-i.y
}`;
    const expected = `define myHelper {
  with input as i

  o.x <- i.y
}
`;
    assert.equal(formatSnippet(input), expected);
  });

  test("bridge with comment, tool handles, and pipes", () => {
    const input = `version 1.5

bridge Query.greet {
#comment
  with std.str.toUpperCase as uc
  with std.str.toLowerCase as lc
  
  with input as i
  with output as o

  o.message <- i.name
  o.upper <- uc: i.name
  o.lower <- lc: i.name
}`;
    const expected = `version 1.5

bridge Query.greet {
  #comment
  with std.str.toUpperCase as uc
  with std.str.toLowerCase as lc
  with input as i
  with output as o

  o.message <- i.name
  o.upper <- uc:i.name
  o.lower <- lc:i.name
}
`;
    assert.equal(formatSnippet(input), expected);
  });

  test("ternary expressions preserve formatting", () => {
    const input = `version 1.5

bridge Query.pricing {
  with input as i
  with output as o

  # String literal branches
  o.tier <- i.isPro ? "premium" : "basic"

  # Numeric literal branches
  o.discount <- i.isPro ? 20 : 5

  # Source ref branches — selects proPrice or basicPrice
  o.price <- i.isPro ? i.proPrice : i.basicPrice
}
`;
    // Should not change
    assert.equal(formatSnippet(input), input);
  });

  test("blank line between top-level blocks", () => {
    const input = `version 1.5

tool geo from std.httpCall
tool weather from std.httpCall
bridge Query.a {
  with input as i
}
bridge Query.b {
  with input as i
}
define helper {
  with input as i
}`;
    const expected = `version 1.5

tool geo from std.httpCall

tool weather from std.httpCall

bridge Query.a {
  with input as i
}

bridge Query.b {
  with input as i
}

define helper {
  with input as i
}
`;
    assert.equal(formatSnippet(input), expected);
  });

  test("not operator preserves space", () => {
    const input = `o.requireMFA <- not i.verified
`;
    // Should not change
    assert.equal(formatSnippet(input), input);
  });

  test("blank lines between comments are preserved", () => {
    const input = `#asdasd

#sdasdsd
`;
    // Should not change
    assert.equal(formatSnippet(input), input);
  });
});
