import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { prettyPrintToSource } from "../src/index.ts";
import { formatSnippet } from "./utils/formatter-test-utils.ts";
import { bridge } from "@stackables/bridge-core";

/**
 * ============================================================================
 * EASY-TO-REVIEW TEST CASES
 *
 * Each test shows:
 *   INPUT    → what the user wrote (possibly messy)
 *   EXPECTED → what the formatter should produce (canonical form)
 * ============================================================================
 */

describe("formatBridge - spacing", () => {
  test("operator spacing: '<-' gets spaces", () => {
    const input = `o.x<-i.y`;
    const expected = `o.x <- i.y\n`;
    assert.equal(formatSnippet(input), expected);
  });

  test("operator spacing: '=' gets spaces", () => {
    const input = `.baseUrl="https://example.com"`;
    const expected = `.baseUrl = "https://example.com"\n`;
    assert.equal(formatSnippet(input), expected);
  });

  test("brace spacing: space before '{'", () => {
    const input = `bridge Query.test{`;
    const expected = `bridge Query.test {\n`;
    assert.equal(formatSnippet(input), expected);
  });

  test("no space after '.' in paths", () => {
    const input = `o.foo.bar`;
    const expected = `o.foo.bar\n`;
    assert.equal(formatSnippet(input), expected);
  });

  test("no space around '.' even with 'from' as property name", () => {
    const input = `c.from.station.id`;
    const expected = `c.from.station.id\n`;
    assert.equal(formatSnippet(input), expected);
  });

  test("'from' keyword gets spaces when used as keyword", () => {
    const input = `tool geo from std.httpCall`;
    const expected = `tool geo from std.httpCall\n`;
    assert.equal(formatSnippet(input), expected);
  });

  test("safe navigation '?.' has no spaces", () => {
    const input = `o.x?.y`;
    const expected = `o.x?.y\n`;
    assert.equal(formatSnippet(input), expected);
  });

  test("parentheses: no space inside", () => {
    const input = `foo( a , b )`;
    const expected = `foo(a, b)\n`;
    assert.equal(formatSnippet(input), expected);
  });

  test("brackets: no space inside", () => {
    const input = `arr[ 0 ]`;
    const expected = `arr[0]\n`;
    assert.equal(formatSnippet(input), expected);
  });
});

describe("formatBridge - indentation", () => {
  test("bridge body is indented 2 spaces", () => {
    const input = `bridge Query.test {
with input as i
o.x <- i.y
}`;
    const expected = `bridge Query.test {
  with input as i

  o.x <- i.y
}
`;
    assert.equal(formatSnippet(input), expected);
  });

  test("nested braces increase indentation", () => {
    const input = `bridge Query.test {
on error {
.retry = true
}
}`;
    const expected = `bridge Query.test {
  on error {
    .retry = true
  }
}
`;
    assert.equal(formatSnippet(input), expected);
  });
});

describe("formatBridge - blank lines", () => {
  test("blank line after version", () => {
    const input = bridge`
      version 1.5
      tool geo from std.httpCall
    `;
    const expected = bridge`
      version 1.5

      tool geo from std.httpCall

    `;
    assert.equal(formatSnippet(input), expected);
  });

  test("preserve single blank line (user grouping)", () => {
    const input = `bridge Query.test {
  with input as i

  o.x <- i.y
}`;
    const expected = `bridge Query.test {
  with input as i

  o.x <- i.y
}
`;
    assert.equal(formatSnippet(input), expected);
  });

  test("collapse multiple blank lines to one", () => {
    const input = `bridge Query.test {
  with input as i


  o.x <- i.y
}`;
    const expected = `bridge Query.test {
  with input as i

  o.x <- i.y
}
`;
    assert.equal(formatSnippet(input), expected);
  });

  test("at least a single blank line between wires", () => {
    const input = `bridge Query.test {
  with input as i
  o.x <- i.y
}`;
    const expected = `bridge Query.test {
  with input as i

  o.x <- i.y
}
`;
    assert.equal(formatSnippet(input), expected);
  });
});

describe("formatBridge - comments", () => {
  test("standalone comment preserved", () => {
    const input = `# This is a comment
tool geo from std.httpCall`;
    const expected = `# This is a comment
tool geo from std.httpCall
`;
    assert.equal(formatSnippet(input), expected);
  });

  test("inline comment stays on same line", () => {
    const input = `tool geo from std.httpCall # inline`;
    const expected = `tool geo from std.httpCall # inline\n`;
    assert.equal(formatSnippet(input), expected);
  });

  test("trailing comment on brace line", () => {
    const input = `bridge Query.test { # comment
}`;
    const expected = `bridge Query.test { # comment
}
`;
    assert.equal(formatSnippet(input), expected);
  });
});

describe("formatBridge - on error blocks", () => {
  test("on error with simple value", () => {
    const input = `on error=null`;
    const expected = `on error = null\n`;
    assert.equal(formatSnippet(input), expected);
  });

  test("on error with JSON object stays on one line", () => {
    const input = `on error = { "connections": [] }`;
    const expected = `on error = {"connections": []}\n`;
    assert.equal(formatSnippet(input), expected);
  });
});

describe("prettyPrintToSource - edge cases", () => {
  test("empty input", () => {
    assert.equal(formatSnippet(""), "");
  });

  test("whitespace only input", () => {
    assert.equal(formatSnippet("   \n  \n"), "");
  });

  test("throws on lexer errors", () => {
    const invalid = `bridge @invalid { }`;
    assert.throws(() => prettyPrintToSource(invalid));
  });

  test("comment-only file", () => {
    const input = `# comment 1
# comment 2`;
    const expected = `# comment 1
# comment 2
`;
    assert.equal(formatSnippet(input), expected);
  });
});

describe("prettyPrintToSource - safety and options", () => {
  test("is idempotent", () => {
    const input = bridge`
      version 1.5
      bridge Query.test {
      with input as i
      o.x<-i.y
      }
    `;
    const once = prettyPrintToSource(input);
    const twice = prettyPrintToSource(once);
    assert.equal(twice, once);
  });

  test("throws on syntax errors", () => {
    assert.throws(() => prettyPrintToSource(`bridge Query.test {`));
  });

  test("uses tabSize when insertSpaces is true", () => {
    const input = bridge`
      version 1.5
      bridge Query.test {
      with input as i
      o.x<-i.y
      }
    `;
    const expected = bridge`
      version 1.5

      bridge Query.test {
          with input as i

          o.x <- i.y
      }

    `;
    assert.equal(
      prettyPrintToSource(input, { tabSize: 4, insertSpaces: true }),
      expected,
    );
  });

  test("uses tabs when insertSpaces is false", () => {
    const input = bridge`
      version 1.5
      bridge Query.test {
      with input as i
      o.x<-i.y
      }
    `;
    const expected = bridge`
      version 1.5

      bridge Query.test {
      	with input as i

      	o.x <- i.y
      }

    `;
    assert.equal(
      prettyPrintToSource(input, { tabSize: 4, insertSpaces: false }),
      expected,
    );
  });
});

describe("formatBridge - line splitting and joining", () => {
  test("content after '{' moves to new indented line", () => {
    const input = `bridge Query.greet {
  with output as o

  o {.message <- i.name
    .upper <- uc:i.name
  }
}`;
    const expected = `bridge Query.greet {
  with output as o

  o {
    .message <- i.name
    .upper <- uc:i.name
  }
}
`;
    assert.equal(formatSnippet(input), expected);
  });

  test("standalone 'as', identifier, and '{' merge with previous line", () => {
    const input = `bridge Query.test {
  with output as o

  o <- api.items[]
   as
  c
  {
    .id <- c.id
  }
}`;
    const expected = `bridge Query.test {
  with output as o

  o <- api.items[] as c {
    .id <- c.id
  }
}
`;
    assert.equal(formatSnippet(input), expected);
  });

  test("'as' in 'with' declaration is not merged incorrectly", () => {
    // with lines should stay separate
    const input = `bridge Query.test {
  with input as i
  with output as o
}`;
    const expected = `bridge Query.test {
  with input as i
  with output as o
}
`;
    assert.equal(formatSnippet(input), expected);
  });

  test("adjacent blocks on same line get separated with blank line", () => {
    // }tool on same line should split into separate lines with blank line
    const input = `tool a from std.httpCall {
  .path = "/a"
}tool b from std.httpCall {
  .path = "/b"
}`;
    const expected = `tool a from std.httpCall {
  .path = "/a"
}

tool b from std.httpCall {
  .path = "/b"
}
`;
    assert.equal(formatSnippet(input), expected);
  });
});
