---
title: Data Transformation
description: The Bridge Language — Definitive Guide
---

## 10. Array Mapping

Map each element of an array individually:

```bridge
o.journeys <- router.journeys[] as j {
  .label <- j.label
  .departureTime <- j.departure
}
```

The `[] as j { }` syntax:

1. Takes the array from `router.journeys`.
2. Creates a shadow scope for each element, bound to `j`.
3. Maps each element's fields according to the inner wires.

### Passthrough inner arrays

If an inner array's shape already matches the GraphQL type, skip explicit
field mapping:

```bridge
o.journeys <- router.journeys[] as j {
  .label <- j.label
  .stops <- j.stops          # ← passthrough: stops array used as-is
}
```

The engine automatically resolves the scalar fields of each stop from the
element data — no nested `[] as` block required.

### Note on array indices

Explicit array indices on the **target** side are not supported:

```bridge
# This will throw a parse error:
o.items[0].name <- api.firstName
```

Use array mapping blocks instead. Indices on the **source** side are fine:

```bridge
o.name <- api.results[0].name     # ← OK: reading first element from source
```

### Alias Declarations (`alias ... as`)

The `alias` keyword creates a named binding that caches the result of a source
expression. It works both inside array mapping blocks and at the top level of a
bridge body.

#### Inside array mappings — evaluate once per element

When mapping over arrays, you may need to pass each element through a tool and
extract multiple fields from the result. Without aliases, this forces the engine
to execute the tool once per field — wasteful.

```bridge
o.list <- api.items[] as it {
  alias enrich:it as resp       # evaluate pipe once per element
  .a <- resp.a                  # cost-0 memory read
  .b <- resp.b                  # cost-0 memory read
}
```

The `alias enrich:it as resp` line:

1. Pipes each element through the `enrich` tool.
2. Caches the result in a local handle named `resp`.
3. Makes `resp` available to all subsequent wires in the same block.

The engine evaluates `enrich` exactly **once per element**, regardless of how
many fields pull from `resp`.

You can also bind a sub-field of the iterator directly:

```bridge
o.list <- api.items[] as it {
  alias it.metadata as m        # bind a sub-object
  .author <- m.author
  .date   <- m.createdAt
}
```

This is purely a readability convenience — it doesn't trigger any tool call.

#### At the bridge body level — rename or cache

Top-level aliases are useful for renaming deeply nested paths or caching pipe
results that are referenced by multiple wires:

```bridge
bridge Query.getUser {
  with std.httpCall as api
  with input as i
  with output as o

  api.path = "/users/1"

  # Perfect for renaming deep paths
  alias api.company.address as addr

  o.city <- addr.city
  o.state <- addr.state
}
```

When the alias wraps a pipe chain, the tool is evaluated **once** regardless of
how many wires read from the cached result:

```bridge
  alias uc:i.category as upperCat   # uc called once
  o.label <- upperCat               # free memory read
  o.title <- upperCat               # free memory read
```

---
