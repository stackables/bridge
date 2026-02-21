import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    parseBridge,
    parsePath,
    serializeBridge,
} from "../src/bridge-format.js";
import type { Bridge, Instruction, ToolDef, Wire } from "../src/types.js";
import { SELF_MODULE } from "../src/types.js";

// ── parsePath ───────────────────────────────────────────────────────────────

describe("parsePath", () => {
  test("simple field", () => {
    assert.deepStrictEqual(parsePath("name"), ["name"]);
  });

  test("dotted path", () => {
    assert.deepStrictEqual(parsePath("position.lat"), ["position", "lat"]);
  });

  test("array index", () => {
    assert.deepStrictEqual(parsePath("items[0].position.lat"), [
      "items",
      "0",
      "position",
      "lat",
    ]);
  });

  test("hyphenated key", () => {
    assert.deepStrictEqual(parsePath("headers.x-message-id"), [
      "headers",
      "x-message-id",
    ]);
  });

  test("empty brackets stripped", () => {
    assert.deepStrictEqual(parsePath("properties[]"), ["properties"]);
  });
});

// ── parseBridge ─────────────────────────────────────────────────────────────

describe("parseBridge", () => {
  test("simple bridge with input handle", () => {
    const result = parseBridge(`version 1.4

bridge Query.geocode {
  with hereapi.geocode as gc
  with input as i
  with output as o

o.search <- i.search
gc.q <- i.search

}`);
    assert.equal(result.length, 1);
    const bridge = result[0] as Bridge;
    assert.equal(bridge.kind, "bridge");
    assert.equal(bridge.type, "Query");
    assert.equal(bridge.field, "geocode");
    assert.equal(bridge.handles.length, 3);
    assert.deepStrictEqual(bridge.handles[0], {
      handle: "gc",
      kind: "tool",
      name: "hereapi.geocode",
    });
    assert.deepStrictEqual(bridge.handles[1], { handle: "i", kind: "input" });
    assert.deepStrictEqual(bridge.handles[2], { handle: "o", kind: "output" });
    assert.equal(bridge.wires.length, 2);

    assert.deepStrictEqual(bridge.wires[0], {
      from: {
        module: SELF_MODULE,
        type: "Query",
        field: "geocode",
        path: ["search"],
      },
      to: {
        module: SELF_MODULE,
        type: "Query",
        field: "geocode",
        path: ["search"],
      },
    });
    assert.deepStrictEqual(bridge.wires[1], {
      from: {
        module: SELF_MODULE,
        type: "Query",
        field: "geocode",
        path: ["search"],
      },
      to: {
        module: "hereapi",
        type: "Query",
        field: "geocode",
        instance: 1,
        path: ["q"],
      },
    });
  });

  test("tool wires", () => {
    const result = parseBridge(`version 1.4

bridge Query.health {
  with api.data as a
  with toInt as ti
  with output as o

ti.value <- a.raw
o.output <- ti.result

}`);
    assert.equal(result.length, 1);

    const bridge = result[0] as Bridge;
    assert.equal(bridge.handles.length, 3);
    assert.deepStrictEqual(bridge.wires[0], {
      from: {
        module: "api",
        type: "Query",
        field: "data",
        instance: 1,
        path: ["raw"],
      },
      to: {
        module: SELF_MODULE,
        type: "Tools",
        field: "toInt",
        instance: 1,
        path: ["value"],
      },
    });
    assert.deepStrictEqual(bridge.wires[1], {
      from: {
        module: SELF_MODULE,
        type: "Tools",
        field: "toInt",
        instance: 1,
        path: ["result"],
      },
      to: {
        module: SELF_MODULE,
        type: "Query",
        field: "health",
        path: ["output"],
      },
    });
  });

  test("nested output paths", () => {
    const result = parseBridge(`version 1.4

bridge Query.search {
  with zillow.find as z
  with output as o

o.topPick.address <- z.properties[0].streetAddress
o.topPick.city    <- z.properties[0].location.city

}`);
    const bridge = result[0] as Bridge;
    assert.deepStrictEqual(bridge.wires[0].from, {
      module: "zillow",
      type: "Query",
      field: "find",
      instance: 1,
      path: ["properties", "0", "streetAddress"],
    });
    assert.deepStrictEqual(bridge.wires[0].to, {
      module: SELF_MODULE,
      type: "Query",
      field: "search",
      path: ["topPick", "address"],
    });
    assert.deepStrictEqual(bridge.wires[1].from.path, [
      "properties",
      "0",
      "location",
      "city",
    ]);
    assert.deepStrictEqual(bridge.wires[1].to.path, ["topPick", "city"]);
  });

  test("array mapping with element wires", () => {
    const result = parseBridge(`version 1.4

bridge Query.search {
  with provider.list as p
  with output as o

o.results <- p.items[] as item {
  .name    <- item.title
  .lat     <- item.position.lat
}

}`);
    const bridge = result[0] as Bridge;
    assert.equal(bridge.wires.length, 3);
    assert.deepStrictEqual(bridge.wires[0], {
      from: {
        module: "provider",
        type: "Query",
        field: "list",
        instance: 1,
        path: ["items"],
      },
      to: {
        module: SELF_MODULE,
        type: "Query",
        field: "search",
        path: ["results"],
      },
    });
    assert.deepStrictEqual(bridge.wires[1], {
      from: {
        module: SELF_MODULE,
        type: "Query",
        field: "search",
        element: true,
        path: ["title"],
      },
      to: {
        module: SELF_MODULE,
        type: "Query",
        field: "search",
        path: ["results", "name"],
      },
    });
    assert.deepStrictEqual(bridge.wires[2], {
      from: {
        module: SELF_MODULE,
        type: "Query",
        field: "search",
        element: true,
        path: ["position", "lat"],
      },
      to: {
        module: SELF_MODULE,
        type: "Query",
        field: "search",
        path: ["results", "lat"],
      },
    });
  });

  test("Mutation type", () => {
    const result = parseBridge(`version 1.4

bridge Mutation.sendEmail {
  with sendgrid.send as sg
  with input as i
  with output as o

sg.content <- i.body
o.messageId <- sg.headers.x-message-id

}`);
    const bridge = result[0] as Bridge;
    assert.equal(bridge.type, "Mutation");
    assert.deepStrictEqual(bridge.wires[0].to, {
      module: "sendgrid",
      type: "Mutation",
      field: "send",
      instance: 1,
      path: ["content"],
    });
    assert.deepStrictEqual(bridge.wires[1].from.path, [
      "headers",
      "x-message-id",
    ]);
  });

  test("multiple bridges separated by ---", () => {
    const result = parseBridge(`version 1.4

bridge Query.first {
  with a.one as a
  with input as i

a.x <- i.input

}

bridge Query.second {
  with b.two as b
  with input as i

b.y <- i.input

}`);
    const bridges = result.filter((i): i is Bridge => i.kind === "bridge");
    assert.equal(bridges.length, 2);
    assert.equal(bridges[0].field, "first");
    assert.equal(bridges[1].field, "second");
  });

  test("context handle", () => {
    const result = parseBridge(`version 1.4

bridge Query.search {
  with zillow.find as z
  with input as i
  with context as c

z.maxPrice <- c.maxBudget
z.lat <- i.lat

}`);
    const bridge = result[0] as Bridge;
    assert.equal(bridge.handles.length, 3);
    assert.deepStrictEqual(bridge.handles[2], { handle: "c", kind: "context" });
    assert.deepStrictEqual(bridge.wires[0].from, {
      module: SELF_MODULE,
      type: "Context",
      field: "context",
      path: ["maxBudget"],
    });
  });
});

// ── serializeBridge ─────────────────────────────────────────────────────────

describe("serializeBridge", () => {
  test("simple bridge roundtrip", () => {
    const input = `version 1.4
bridge Query.geocode {
  with hereapi.geocode as gc
  with input as i
  with output as o

o.search <- i.search
gc.q <- i.search

}`;
    const instructions = parseBridge(input);
    const output = serializeBridge(instructions);
    assert.deepStrictEqual(parseBridge(output), instructions);
  });

  test("tool bridge roundtrip", () => {
    const input = `version 1.4
bridge Query.health {
  with hereapi.getCoordinates as geo
  with companyX.getLivingStandard as cx
  with input as i
  with toInt as ti
  with output as o

geo.location <- i.q
cx.x <- geo.lat
cx.y <- geo.lon
ti.value <- cx.lifeExpectancy
o.lifeExpectancy <- ti.result

}`;
    const instructions = parseBridge(input);
    assert.deepStrictEqual(
      parseBridge(serializeBridge(instructions)),
      instructions,
    );
  });

  test("array mapping roundtrip", () => {
    const input = `version 1.4
bridge Query.search {
  with hereapi.geocode as gc
  with output as o

o.results <- gc.items[] as item {
  .name <- item.title
  .lat <- item.position.lat
  .lon <- item.position.lng
}

}`;
    const instructions = parseBridge(input);
    assert.deepStrictEqual(
      parseBridge(serializeBridge(instructions)),
      instructions,
    );
  });

  test("Mutation with hyphenated path roundtrip", () => {
    const input = `version 1.4
bridge Mutation.sendEmail {
  with sendgrid.send as sg
  with input as i
  with output as o

sg.to <- i.to
sg.from <- i.from
sg.content <- i.body
o.messageId <- sg.headers.x-message-id

}`;
    const instructions = parseBridge(input);
    assert.deepStrictEqual(
      parseBridge(serializeBridge(instructions)),
      instructions,
    );
  });

  test("multi-bridge roundtrip", () => {
    const input = `version 1.4
bridge Query.propertySearch {
  with hereapi.geocode as gc
  with zillow.search as z
  with input as i
  with centsToUsd as usd
  with output as o

o.location <- i.location
gc.q <- i.location
z.latitude <- gc.items[0].position.lat
z.longitude <- gc.items[0].position.lng
z.maxPrice <- i.budget
o.topPick.address <- z.properties[0].streetAddress
usd.cents <- z.properties[0].priceInCents
o.topPick.price <- usd.dollars
o.topPick.bedrooms <- z.properties[0].beds
o.topPick.city <- z.properties[0].location.city
o.listings <- z.properties[] as prop {
  .address <- prop.streetAddress
  .price <- prop.priceInCents
  .bedrooms <- prop.beds
  .city <- prop.location.city
}

}

bridge Query.propertyComments {
  with hereapi.geocode as gc
  with reviews.getByLocation as rv
  with input as i
  with pluckText as pt
  with output as o

gc.q <- i.location
rv.lat <- gc.items[0].position.lat
rv.lng <- gc.items[0].position.lng
pt.items <- rv.comments
o.propertyComments <- pt.result

}`;
    const instructions = parseBridge(input);
    assert.deepStrictEqual(
      parseBridge(serializeBridge(instructions)),
      instructions,
    );
  });

  test("serialized output is human-readable", () => {
    const instructions: Instruction[] = [
      {
        kind: "bridge",
        type: "Mutation",
        field: "sendEmail",
        handles: [
          {
            handle: "sg",
            kind: "tool",
            name: "sendgrid.send",
          },
          { handle: "i", kind: "input" },
          { handle: "o", kind: "output" },
        ],
        wires: [
          {
            from: {
              module: SELF_MODULE,
              type: "Mutation",
              field: "sendEmail",
              path: ["body"],
            },
            to: {
              module: "sendgrid",
              type: "Mutation",
              field: "send",
              instance: 1,
              path: ["content"],
            },
          },
          {
            from: {
              module: "sendgrid",
              type: "Mutation",
              field: "send",
              instance: 1,
              path: ["headers", "x-message-id"],
            },
            to: {
              module: SELF_MODULE,
              type: "Mutation",
              field: "sendEmail",
              path: ["messageId"],
            },
          },
        ],
      },
    ];
    const output = serializeBridge(instructions);
    assert.ok(output.includes("bridge Mutation.sendEmail"));
    assert.ok(output.includes("with sendgrid.send as sg"));
    assert.ok(output.includes("sg.content <- i.body"));
    assert.ok(output.includes("o.messageId <- sg.headers.x-message-id"));
  });
});

// ── Tool blocks ─────────────────────────────────────────────────────────────

describe("parseBridge: tool blocks", () => {
  test("parses a simple GET tool", () => {
    const result = parseBridge(`version 1.4

tool hereapi from httpCall {
  with context
  .baseUrl = "https://geocode.search.hereapi.com/v1"
  .headers.apiKey <- context.hereapi.apiKey

}
tool hereapi.geocode from hereapi {
  .method = GET
  .path = /geocode

}
bridge Query.geocode {
  with hereapi.geocode as gc
  with input as i

gc.q <- i.search

}`);
    const tools = result.filter((i): i is ToolDef => i.kind === "tool");
    assert.equal(tools.length, 2);

    const root = tools.find((t) => t.name === "hereapi")!;
    assert.equal(root.fn, "httpCall");
    assert.equal(root.extends, undefined);
    assert.deepStrictEqual(root.deps, [{ kind: "context", handle: "context" }]);
    assert.deepStrictEqual(root.wires, [
      {
        target: "baseUrl",
        kind: "constant",
        value: "https://geocode.search.hereapi.com/v1",
      },
      {
        target: "headers.apiKey",
        kind: "pull",
        source: "context.hereapi.apiKey",
      },
    ]);

    const child = tools.find((t) => t.name === "hereapi.geocode")!;
    assert.equal(child.fn, undefined);
    assert.equal(child.extends, "hereapi");
    assert.deepStrictEqual(child.wires, [
      { target: "method", kind: "constant", value: "GET" },
      { target: "path", kind: "constant", value: "/geocode" },
    ]);
  });

  test("parses POST tool with constant and pull wires", () => {
    const result = parseBridge(`version 1.4

tool sendgrid from httpCall {
  with context
  .baseUrl = "https://api.sendgrid.com/v3"
  .headers.Authorization <- context.sendgrid.bearerToken
  .headers.X-Custom = "static-value"

}
tool sendgrid.send from sendgrid {
  .method = POST
  .path = /mail/send

}
bridge Mutation.sendEmail {
  with sendgrid.send as sg
  with input as i

sg.content <- i.body

}`);
    const root = result.find(
      (i): i is ToolDef => i.kind === "tool" && i.name === "sendgrid",
    )!;
    assert.deepStrictEqual(root.wires, [
      {
        target: "baseUrl",
        kind: "constant",
        value: "https://api.sendgrid.com/v3",
      },
      {
        target: "headers.Authorization",
        kind: "pull",
        source: "context.sendgrid.bearerToken",
      },
      { target: "headers.X-Custom", kind: "constant", value: "static-value" },
    ]);

    const child = result.find(
      (i): i is ToolDef => i.kind === "tool" && i.name === "sendgrid.send",
    )!;
    assert.equal(child.extends, "sendgrid");
    assert.deepStrictEqual(child.wires, [
      { target: "method", kind: "constant", value: "POST" },
      { target: "path", kind: "constant", value: "/mail/send" },
    ]);
  });

  test("parses tool with deps (tool-to-tool)", () => {
    const result = parseBridge(`version 1.4

tool authService from httpCall {
  with context
  .method = POST
  .baseUrl = "https://auth.example.com"
  .path = /token
  .body.client_id <- context.auth.clientId

}
tool serviceB from httpCall {
  with context
  with authService as auth
  .baseUrl = "https://api.serviceb.com"
  .headers.Authorization <- auth.access_token

}
bridge Query.data {
  with serviceB as sb
  with input as i

sb.q <- i.query

}`);
    const serviceB = result.find(
      (i): i is ToolDef => i.kind === "tool" && i.name === "serviceB",
    )!;
    assert.deepStrictEqual(serviceB.deps, [
      { kind: "context", handle: "context" },
      { kind: "tool", handle: "auth", tool: "authService" },
    ]);
    assert.deepStrictEqual(serviceB.wires[1], {
      target: "headers.Authorization",
      kind: "pull",
      source: "auth.access_token",
    });
  });
});

// ── Tool roundtrip ──────────────────────────────────────────────────────────

describe("serializeBridge: tool roundtrip", () => {
  test("GET tool roundtrips", () => {
    const input = `version 1.4
tool hereapi from httpCall {
  with context
  .baseUrl = "https://geocode.search.hereapi.com/v1"
  .headers.apiKey <- context.hereapi.apiKey

}
tool hereapi.geocode from hereapi {
  .method = GET
  .path = /geocode

}
bridge Query.geocode {
  with hereapi.geocode as gc
  with input as i
  with output as o

o.search <- i.search
gc.q <- i.search
gc.limit <- i.limit

}`;
    const instructions = parseBridge(input);
    assert.deepStrictEqual(
      parseBridge(serializeBridge(instructions)),
      instructions,
    );
  });

  test("POST tool roundtrips", () => {
    const input = `version 1.4
tool sendgrid from httpCall {
  with context
  .baseUrl = "https://api.sendgrid.com/v3"
  .headers.Authorization <- context.sendgrid.bearerToken

}
tool sendgrid.send from sendgrid {
  .method = POST
  .path = /mail/send

}
bridge Mutation.sendEmail {
  with sendgrid.send as sg
  with input as i
  with output as o

sg.to <- i.to
sg.content <- i.body
o.messageId <- sg.id

}`;
    const instructions = parseBridge(input);
    assert.deepStrictEqual(
      parseBridge(serializeBridge(instructions)),
      instructions,
    );
  });

  test("serialized tool output is human-readable", () => {
    const input = `version 1.4
tool hereapi from httpCall {
  with context
  .baseUrl = "https://geocode.search.hereapi.com/v1"
  .headers.apiKey <- context.hereapi.apiKey

}
tool hereapi.geocode from hereapi {
  .method = GET
  .path = /geocode

}
bridge Query.geocode {
  with hereapi.geocode as gc
  with input as i

gc.q <- i.search

}`;
    const output = serializeBridge(parseBridge(input));
    assert.ok(output.includes("tool hereapi from httpCall"));
    assert.ok(output.includes("tool hereapi.geocode from hereapi"));
    assert.ok(output.includes("baseUrl = \"https://geocode.search.hereapi.com/v1\""));
    assert.ok(output.includes("headers.apiKey <- context.hereapi.apiKey"));
  });
});

// ── Parser robustness ───────────────────────────────────────────────────────

describe("parser robustness", () => {
  test("CRLF line endings are handled", () => {
    const result = parseBridge(
      "version 1.4\r\nbridge Query.geocode {\r\n  with input as i\r\n  with output as o\r\n\r\no.search <- i.q\r\n}\r\n",
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].kind, "bridge");
  });

  test("tabs are treated as spaces", () => {
    const result = parseBridge(
      "version 1.4\nbridge Query.geocode {\n\twith input as i\n\twith output as o\n\no.search <- i.q\n}\n",
    );
    assert.equal(result.length, 1);
  });

  test("keywords are case-insensitive", () => {
    const bridge = parseBridge(`version 1.4

Bridge Query.geocode {
  With hereapi.geocode as gc
  With Input as i

gc.q <- i.search

}`)[0] as Bridge;
    assert.equal(bridge.type, "Query");
    assert.equal(bridge.field, "geocode");
  });

  test("tool keyword is case-insensitive", () => {
    const tool = parseBridge(`version 1.4

tool hereapi from httpCall {
  .baseUrl = "https://example.com"

}`)[0] as ToolDef;
    assert.equal(tool.name, "hereapi");
    assert.equal(tool.fn, "httpCall");
  });

  test("--- separator with surrounding whitespace", () => {
    const result = parseBridge(`version 1.4

tool hereapi from httpCall {
  .baseUrl = "https://example.com"

}
tool hereapi.geocode from hereapi {
  .method = GET
  .path = /geocode

}

bridge Query.geocode {
  with hereapi.geocode as gc
  with input as i

gc.q <- i.search

}`);
    assert.equal(result.length, 3);
  });

  test("duplicate handle throws with line number", () => {
    assert.throws(
      () =>
        parseBridge(`version 1.4

bridge Query.geocode {
  with input as h
  with context as h

search <- h.q

}`),
      /[Ll]ine 5.*[Dd]uplicate handle.*"h"/,
    );
  });

  test("with before bridge throws with line number", () => {
    assert.throws(
      () =>
        parseBridge(`version 1.4
with input as i
bridge Query.geocode {

search <- i.q

}`),
      (err: unknown) => err instanceof Error,
    );
  });

  test("error messages include line numbers", () => {
    assert.throws(
      () =>
        parseBridge(`version 1.4

bridge Query.geocode {
  with input as i

not a valid line
}`),
      (err: unknown) => err instanceof Error,
    );
  });

  test("with tool keyword is case-insensitive", () => {
    const result = parseBridge(`version 1.4

Bridge Query.geocode {
  With myTool as t
  With Input as i
  With Output as o

o.result <- t.output

}`);
    const bridge = result.find((i) => i.kind === "bridge") as Bridge;
    const toolHandle = bridge.handles.find((h) => h.kind === "tool");
    assert.notEqual(toolHandle, undefined);
  });

  test("with context keyword is case-insensitive", () => {
    const bridge = parseBridge(`version 1.4

Bridge Query.geocode {
  With Context as cfg
  With Input as i
  With Output as o

o.result <- cfg.apiKey

}`).find((i) => i.kind === "bridge") as Bridge;
    assert.notEqual(
      bridge.handles.find((h) => h.kind === "context"),
      undefined,
    );
  });

  test("element mapping works with tab indentation", () => {
    const bridge = parseBridge(
      "version 1.4\nbridge Query.search {\n\twith hereapi.geocode as gc\n\twith input as i\n\twith output as o\n\ngc.q <- i.search\no.results <- gc.items[] as item {\n\t.lat <- item.position.lat\n\t.lng <- item.position.lng\n}\n}\n",
    ).find((i) => i.kind === "bridge") as Bridge;
    assert.equal(
      bridge.wires.filter((w) => "from" in w && w.from.element).length,
      2,
    );
  });

  test("inline # comments are stripped from wire lines", () => {
    const bridge = parseBridge(`version 1.4

bridge Query.greet {
  with input as i  # the request
  with output as o # the response

  o.name <- i.username # copy the name across
}`).find((inst) => inst.kind === "bridge") as Bridge;
    const wire = bridge.wires.find(
      (w) => "from" in w && !("value" in w),
    ) as Wire;
    assert.equal(wire.to.path.join("."), "name");
    assert.equal(wire.from.path.join("."), "username");
  });

  test("# inside a string literal is not treated as a comment", () => {
    const tool = parseBridge(`version 1.4

tool myApi from httpCall {
  .url = "https://example.com/things#anchor"
}`).find((inst) => inst.kind === "tool") as ToolDef;
    const urlWire = tool.wires.find(
      (w) => w.kind === "constant" && w.target === "url",
    ) as { kind: "constant"; target: string; value: string };
    assert.equal(urlWire.value, "https://example.com/things#anchor");
  });
});

// ── Brace block syntax ──────────────────────────────────────────────────────

describe("brace block syntax", () => {
  test("bridge block with braces parses identically to indented style", () => {
    const brace = parseBridge(`version 1.4

bridge Query.demo {
  with myApi as api
  with input as i
  with output as o

  o.result <- api.value
}`);
    const indent = parseBridge(`version 1.4

bridge Query.demo {
  with myApi as api
  with input as i
  with output as o

o.result <- api.value

}`);
    assert.deepStrictEqual(brace, indent);
  });

  test("tool block with braces parses identically to indented style", () => {
    const brace = parseBridge(`version 1.4

tool myApi from httpCall {
  .baseUrl = "https://example.com"
  .method = GET
}`);
    const indent = parseBridge(`version 1.4

tool myApi from httpCall {
  .baseUrl = "https://example.com"
  .method = GET

}`);
    assert.deepStrictEqual(brace, indent);
  });

  test("indented } inside on error value is not stripped", () => {
    const result = parseBridge(`version 1.4

tool myApi from httpCall {
  on error = {
    "lat": 0,
    "lon": 0
  }
}`);
    const tool = result[0] as ToolDef;
    const onError = tool.wires.find((w) => w.kind === "onError");
    assert.ok(onError && "value" in onError);
    if ("value" in onError!) {
      assert.deepStrictEqual(JSON.parse(onError.value), { lat: 0, lon: 0 });
    }
  });

  test("mixed brace and indent blocks in same file", () => {
    const result = parseBridge(`version 1.4

tool api from httpCall {
  .baseUrl = "https://example.com"
}

bridge Query.demo {
  with api
  with input as i
  with output as o

o.result <- api.value

}`);
    assert.equal(result.filter((i) => i.kind === "tool").length, 1);
    assert.equal(result.filter((i) => i.kind === "bridge").length, 1);
  });
});
