---
title: Using Tools & Pipes
description: The Bridge Language — Definitive Guide
---

## 11. Pipe Operator

Route data through a transform tool inline:

```bridge
o.name <- upperCase:api.rawName
```

This is syntactic sugar for: "take `api.rawName`, pass it through `upperCase`,
wire the result to `o.name`."

### Chained pipes

```bridge
o.name <- trim:upperCase:api.rawName
```

Pipes evaluate right to left: `rawName → upperCase → trim → o.name`.

### Pipe with extra parameters

If the pipe tool needs additional configuration:

```bridge
bridge Query.convert {
  with priceApi as api
  with convertCurrency as convert
  with input as i
  with output as o

  convert.currency <- i.targetCurrency
  o.price <- convert:api.rawPrice
}
```

The `convert` tool receives both the piped value and the `currency` parameter.

---

## Node Aliasing (alias ... as)

Top-level aliases are useful for caching pipe results that are referenced by multiple wires, or for renaming deeply nested paths.
When the alias wraps a pipe chain, the tool is evaluated once regardless of how many wires read from the cached result.

```bridge
# api is called exactly once
alias api:i.userId as user
o.city <- user.city
o.state <- user.state
```
