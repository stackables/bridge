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

The Bridge engine stores the version tag as metadata on each tool binding. At runtime, the host application can use this information to:

1. **Select the correct tool implementation** based on the requested version.
2. **Validate compatibility** before execution starts.
3. **Log and audit** which tool versions were used in each request.

The version tag does not change how the engine resolves tool names — it provides an **annotation** that tooling and infrastructure can act on.

### Example: version-aware tool registry

```typescript
import { bridgeTransform, parseBridge } from "@stackables/bridge";

// Build a version-aware tool map
const tools = {
  geocoder: versionedTool({
    "1.0": geocoderV1,
    "2.1": geocoderV2,
  }),
};

const schema = bridgeTransform(
  createSchema({ typeDefs }),
  parseBridge(bridgeText),
  { tools },
);
```

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
| `version 2.0` | `1.x`         | ❌ Error: different major version             |

Within the same major version, the standard library only adds tools and features — it never removes or changes existing behavior. This means:

- **Old bridges always work** on newer std releases (forward compatible).
- **New bridges fail early** on older std releases with a clear error message telling you exactly which version to install.

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
