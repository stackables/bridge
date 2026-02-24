---
title: Core Concepts
---

The Bridge is a declarative dataflow language that wires GraphQL fields to data
sources — APIs, transforms, constants, and other tools. You describe **what**
data goes **where**; the engine figures out **when** and **how** to fetch it.

This document is the single source of truth for Bridge language semantics. It
covers syntax, execution model, and the cost-aware resolution strategy that
keeps your API bill sane.

## File Structure

A `.bridge` file starts with a version declaration and contains one or more
blocks:

```bridge
version 1.4

const defaultCurrency = "EUR"

tool hereGeo from httpCall {
  .baseUrl = "https://geocode.search.hereapi.com/v1"
  .method = GET
  .path = /geocode
}

bridge Query.getWeather {
  with hereGeo as geo
  with input as i
  with output as o

  geo.q <- i.cityName
  o.lat <- geo.items[0].position.lat
  o.lon <- geo.items[0].position.lng
}
```

Blocks are separated by blank lines. Comments start with `#`.

---

## 9. Execution Model

### Pull-based resolution

The engine is demand-driven. When GraphQL asks for a field:

1. **Match** — find wires whose target matches the requested field.
2. **Resolve** — trace backward through the wire's source.
3. **Schedule** — if the source is a tool, schedule the tool call (building
   its input from tool wires + bridge wires).
4. **Cache** — tool results are cached per request. The same tool is never
   called twice within a single GraphQL operation.

### Concurrency model

- **Independent targets** run concurrently. If a bridge requests `o.lat` and
  `o.name` from different tools, both tool calls happen in parallel.
- **Same-target wires** (overdefinition or `||` chains) run **sequentially**
  with short-circuit. The engine stops as soon as it finds data.
- **Tool input wires** run concurrently. A tool's `.param1 <- source1` and
  `.param2 <- source2` are resolved in parallel before the tool is called.

### Shadow trees (array elements)

When a wire maps an array (see [Array Mapping](#10-array-mapping)), the engine
creates a **shadow tree** for each element. A shadow tree inherits its parent's
state and context through a scope chain — you can nest arrays arbitrarily deep.
