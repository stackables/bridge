---
title: Tool Versioning
description: Pin tool dependencies to specific versions for reproducible builds and safe upgrades.
---

Bridge files declare which tools they depend on using `with` statements. The **`@version`** syntax lets you pin a tool dependency to a specific version, giving you control over when and how upgrades happen.

## Why version tools?

Without version pinning, a bridge file silently picks up whatever tool version the host application provides. This works well during development, but in production you want:

- **Reproducibility** — the same bridge file produces the same results on every deploy.
- **Safe upgrades** — update one tool at a time without breaking unrelated bridges.
- **Auditability** — see at a glance which version of each tool a bridge depends on.

## Syntax

Add a version tag directly after the tool name in a `with` statement using the `@` symbol:

```bridge
bridge Query.search {
  with geocoder@2.1 as geo
  with input as i
  with output as o

  geo.q <- i.query
  o.results <- geo.items
}
```

The `@2.1` suffix declares that this bridge expects version 2.1 of the `geocoder` tool.

### Namespaced tools

Version tags work with dotted (namespaced) tool names:

```bridge
bridge Query.weather {
  with myCorp.weather.forecast@1.3 as fc
  with input as i
  with output as o

  fc.location <- i.city
  o.temperature <- fc.temp
}
```

### Standard library tools

You can also version standard library tools:

```bridge
bridge Query.format {
  with std.str.upper@1.5 as upper
  with input as i
  with output as o

  o.name <- upper(i.raw)
}
```

### Tool block dependencies

Tool blocks support version tags on their `with` declarations too:

```bridge
tool enrichedSearch from std.httpCall {
  with stripe@2.0 as pay
  .baseUrl = "https://api.example.com"
}
```

## Version format

A version tag starts with `@` followed by a numeric version:

| Example  | Meaning             |
| -------- | ------------------- |
| `@2`     | Major version 2     |
| `@2.1`   | Version 2.1         |
| `@2.1.3` | Exact version 2.1.3 |

The version is recorded as metadata on the tool handle and is available to the host runtime for resolution logic.

## How version resolution works

The Bridge engine validates versioned tool handles at startup — **before** any execution begins. If a required version cannot be satisfied, the engine throws immediately with an actionable error message.

### Resolution rules

For each handle with `@version`:

1. **Versioned key lookup** — the engine checks for a flat key `name@version` in the tools map (e.g., `"std.str.toLowerCase@999.1"`). If found, it uses that function.
2. **Versioned namespace key lookup** — the engine checks for namespace keys containing `@version` (e.g., `"std.str@999.1"` or `"std@999.1"`) and traverses the remaining path within that namespace.
3. **Standard library check** (for `std.*` tools) — if no versioned key exists, the engine compares the requested version against the bundled `STD_VERSION`. If the std satisfies the version (same major, equal-or-higher minor), the bundled tool is used.
4. **Error** — if none is satisfied, the engine throws before execution starts.

### Providing versioned tools

Use a **flat key** with the `@` version suffix in your tools map, or a **versioned namespace key** for providing entire namespaces:

```typescript
import { bridgeTransform, parseBridge } from "@stackables/bridge";

const schema = bridgeTransform(
  createSchema({ typeDefs }),
  parseBridge(bridgeText),
  {
    tools: {
      // Flat versioned key — single tool
      "std.str.toLowerCase@999.1": (opts: { in: string }) =>
        opts.in?.toLowerCase(),

      // Versioned namespace key — entire sub-namespace
      "myApi@2.0": {
        getData: async (input) =>
          fetch(`https://api-v2.example.com/data?q=${input.query}`).then((r) =>
            r.json(),
          ),
        getUser: async (input) =>
          fetch(`https://api-v2.example.com/user/${input.id}`).then((r) =>
            r.json(),
          ),
      },
    },
  },
);
```

This lets you run bridge files that require tool versions **beyond** what the bundled std provides, or provide completely custom tool implementations at a specific version.

### Side-by-side versions

Different handles can reference the same tool at different versions. The engine resolves each handle independently:

```bridge
version 1.5

bridge Query.format {
  with std.str.toUpperCase as up          # uses bundled std (1.5)
  with std.str.toLowerCase@999.1 as lo    # uses injected version
  with input as i
  with output as o

  o.upper <- up:i.text
  o.lower <- lo:i.text
}
```

```typescript
// Server-side: inject only the versioned tool
const schema = bridgeTransform(schema, instructions, {
  tools: {
    "std.str.toLowerCase@999.1": customLowerCase,
  },
});
```

The unversioned `toUpperCase` uses the bundled standard library; the versioned `toLowerCase@999.1` uses the explicitly provided function.

### Error messages

When a versioned handle cannot be satisfied:

```
Tool "std.str.toLowerCase@999.1" requires standard library ≥ 999.1,
but the installed @stackables/bridge-stdlib is 1.5.0.
Either update the stdlib or provide the tool as
"std.str.toLowerCase@999.1" in the tools map.
```

For non-std tools:

```
Tool "myApi.getData@2.0" is not available.
Provide it as "myApi.getData@2.0" in the tools map.
```

### IDE warnings

The language service (VS Code extension, playground) emits a **warning** when a `@version` tag on a `std.*` tool exceeds the bundled standard library version. This tells you the tool must be provided at runtime.

## The `version` header

Every bridge file starts with a `version` header that declares the **language version**:

```bridge
version 1.5
```

This header serves two purposes:

1. **Syntax compatibility** — the parser accepts any file within the same major version (e.g. `1.5`, `1.7`, `1.12`). A major version bump (e.g. `2.0`) indicates breaking syntax changes and will be rejected by a `1.x` parser.
2. **Standard library minimum version** — the engine checks that the installed `@stackables/bridge-stdlib` satisfies the declared version.

### Compatibility rules

| Bridge file   | Installed std | Result                                        |
| ------------- | ------------- | --------------------------------------------- |
| `version 1.5` | `1.5.0`       | ✅ Works                                      |
| `version 1.5` | `1.5.7`       | ✅ Works (patch is irrelevant)                |
| `version 1.5` | `1.7.0`       | ✅ Works (newer minor is backward compatible) |
| `version 1.7` | `1.5.0`       | ❌ Error: std too old                         |
| `version 1.7` | `1.7.0`       | ✅ Works                                      |
| `version 2.0` | `1.x`         | ❌ Error: different major — provide 2.x std   |

Within the same major version, the standard library only adds tools and features — it never removes or changes existing behavior. This means:

- **Old bridges always work** on newer std releases (forward compatible).
- **New bridges fail early** on older std releases with a clear error message telling you exactly which version to install.

### Cross-major version support

When a new major version of the standard library is released (e.g. `2.0`), bridge files written for the previous major (e.g. `version 1.5`) still work. The engine tells you exactly what to provide:

```
Bridge version 1.5 requires a 1.x standard library,
but the bundled std is 2.0.0 (major version 2).
Provide a compatible std as "std@1.5" in the tools map.
```

To keep your old bridges working alongside the new std, use a **versioned namespace key** in the tools map:

```typescript
// Install the old std alongside the new one:
//   npm install @stackables/bridge-stdlib-v1@npm:@stackables/bridge-stdlib@1.x

import { std as stdV1 } from "@stackables/bridge-stdlib-v1";
import { executeBridge, parseBridgeFormat } from "@stackables/bridge";

const { instructions } = parseBridgeFormat(bridgeText);
const { data } = await executeBridge({
  instructions,
  operation: "Query.myField",
  input: { city: "Berlin" },
  // Provide the 1.x std via a versioned namespace key
  tools: { "std@1.5": stdV1 },
});
```

The same pattern works in the GraphQL adapter:

```typescript
import { bridgeTransform } from "@stackables/bridge";

const schema = bridgeTransform(baseSchema, instructions, {
  tools: {
    "std@1.5": stdV1,
    // your other tools
  },
});
```

You can also provide versioned **sub-namespaces** for more granular overrides:

```typescript
tools: {
  // Override just the array tools at a specific version
  "std.arr@1.7": { toArray: customToArray, flat: customFlat },
  // Override a single tool via a flat key
  "std.str.toLowerCase@999.1": customLowerCase,
}
```

The parser itself declares a supported version **range** (min/max major version). When the parser is upgraded to support both 1.x and 2.x syntax, it will accept bridge files from either major version. You can inspect the parser's supported range:

```typescript
import { PARSER_VERSION } from "@stackables/bridge";

console.log(PARSER_VERSION);
// { current: "1.5", minMajor: 1, maxMajor: 1 }
```

### Error messages

When the version check fails, you get an actionable error:

```
Bridge version 1.7 requires standard library ≥ 1.7,
but the installed @stackables/bridge-stdlib is 1.5.0.
Update @stackables/bridge-stdlib to 1.7.0 or later.
```

## Best practices

1. **Pin versions in production bridges.** Use unversioned handles only during prototyping.
2. **Use the same version tag across related bridges.** If two bridges compose the same tool, they should agree on the version.
3. **Start without versions, add them when stabilizing.** Version tags are optional — add them when you're ready to lock down behavior.
