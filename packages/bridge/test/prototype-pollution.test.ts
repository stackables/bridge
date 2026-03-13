import assert from "node:assert/strict";
import { regressionTest } from "./utils/regression.ts";
import { bridge } from "@stackables/bridge";

// ══════════════════════════════════════════════════════════════════════════════
// Prototype pollution guards
//
// These tests verify that the runtime and compiler reject unsafe property
// names (__proto__, constructor, prototype) in wire assignments, source
// traversals, and tool lookups.
// ══════════════════════════════════════════════════════════════════════════════

regressionTest("prototype pollution – setNested guard", {
  bridge: bridge`
    version 1.5

    bridge Query.setProto {
      with api as a
      with input as i
      with output as o
      a.__proto__ <- i.x
      o.result <- a.safe
    }

    bridge Query.setConstructor {
      with api as a
      with input as i
      with output as o
      a.constructor <- i.x
      o.result <- a.safe
    }

    bridge Query.setPrototype {
      with api as a
      with input as i
      with output as o
      a.prototype <- i.x
      o.result <- a.safe
    }
  `,
  tools: { api: async () => ({ safe: "ok" }) },
  scenarios: {
    "Query.setProto": {
      "blocks __proto__ via bridge wire input path": {
        input: { x: "hacked" },
        assertError: /Unsafe assignment key: __proto__/,
        assertTraces: 0,
      },
    },
    "Query.setConstructor": {
      "blocks constructor via bridge wire input path": {
        input: { x: "hacked" },
        assertError: /Unsafe assignment key: constructor/,
        assertTraces: 0,
      },
    },
    "Query.setPrototype": {
      "blocks prototype via bridge wire input path": {
        input: { x: "hacked" },
        assertError: /Unsafe assignment key: prototype/,
        assertTraces: 0,
      },
    },
  },
});

regressionTest("prototype pollution – pullSingle guard", {
  bridge: bridge`
    version 1.5

    bridge Query.pullProto {
      with api as a
      with output as o
      o.result <- a.__proto__
    }

    bridge Query.pullConstructor {
      with api as a
      with output as o
      o.result <- a.constructor
    }
  `,
  tools: { api: async () => ({ data: "ok" }) },
  scenarios: {
    "Query.pullProto": {
      "blocks __proto__ traversal on source ref": {
        input: {},
        assertError: /Unsafe property traversal: __proto__/,
        // Runtime calls the tool (1 trace) then detects unsafe traversal;
        // compiled engine catches it statically before calling (0 traces).
        assertTraces: (t) => assert.ok(t.length <= 1),
      },
    },
    "Query.pullConstructor": {
      "blocks constructor traversal on source ref": {
        input: {},
        assertError: /Unsafe property traversal: constructor/,
        // See pullProto comment — engine-dependent trace count.
        assertTraces: (t) => assert.ok(t.length <= 1),
      },
    },
  },
});

regressionTest("prototype pollution – tool lookup guard", {
  bridge: bridge`
    version 1.5

    bridge Query.toolProto {
      with foo.__proto__.bar as evil
      with output as o
      o.result <- evil.data
    }

    bridge Query.toolConstructor {
      with foo.constructor as evil
      with output as o
      o.result <- evil.data
    }

    bridge Query.toolPrototype {
      with foo.prototype as evil
      with output as o
      o.result <- evil.data
    }
  `,
  tools: {
    foo: {
      bar: async () => ({ data: "ok" }),
      safe: async () => ({ data: "ok" }),
    },
  },
  scenarios: {
    "Query.toolProto": {
      "blocks __proto__ in dotted tool name": {
        input: {},
        assertError: /No tool found/,
        assertTraces: 0,
      },
    },
    "Query.toolConstructor": {
      "blocks constructor in dotted tool name": {
        input: {},
        assertError: /No tool found/,
        assertTraces: 0,
      },
    },
    "Query.toolPrototype": {
      "blocks prototype in dotted tool name": {
        input: {},
        assertError: /No tool found/,
        assertTraces: 0,
      },
    },
  },
});
