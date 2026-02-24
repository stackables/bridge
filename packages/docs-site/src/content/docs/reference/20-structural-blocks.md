---
title: Structural Blocks
description: The Bridge Language — Definitive Guide
---

## 2. Bridge Blocks

A bridge block wires a single GraphQL field to its data sources.

```bridge
bridge Query.fieldName {
  with <tool-or-source> as <handle>
  ...
  <wires>
}
```

### Handle declarations

Every reference in the wire body must go through a declared handle:

| Declaration           | What it provides                                       |
| --------------------- | ------------------------------------------------------ |
| `with myTool as t`    | Named tool — `t.field` reads tool output               |
| `with input as i`     | GraphQL arguments — `i.argName`                        |
| `with output as o`    | GraphQL return type — `o.fieldName` is the wire target |
| `with context as ctx` | Server context (auth tokens, config, etc.)             |
| `with const as c`     | Named constants declared in the file                   |
| `with myDefine as d`  | A reusable define block (macro)                        |

### Passthrough shorthand

When a tool's output shape matches the GraphQL type exactly:

```bridge
bridge Query.rawData with myTool
```

This skips all wiring — every field on the return type is pulled directly from
the tool result.

---

## 3. Tool Blocks

Tool blocks configure reusable API call templates.

```bridge
tool hereGeo from httpCall {
  with context
  .baseUrl = "https://geocode.search.hereapi.com/v1"
  .method = GET
  .path = /geocode
  .headers.apiKey <- context.hereApiKey
}
```

### Constant wires (`.target = value`)

Set a fixed string value on the tool's input object:

```bridge
.baseUrl = "https://api.example.com"
.method = POST
```

### Pull wires (`.target <- source`)

Pull a value from a dependency at call time:

```bridge
.headers.Authorization <- context.token
.userId <- auth.sub
```

### Dependencies (`with`)

Tool blocks declare their own dependencies:

```bridge
tool secured from httpCall {
  with context                    # brings GraphQL context
  with authService as auth        # brings another tool's output
  with const                      # brings named constants
  .headers.token <- context.jwt
  .baseUrl <- const.apiBaseUrl
}
```

### Error fallback (`on error`)

Provides a fallback value when the tool call throws:

```bridge
tool fragileApi from httpCall {
  .baseUrl = "https://unstable.example.com"
  on error = { "lat": 0, "lon": 0 }
}
```

Or pull the fallback from context:

```bridge
  on error <- context.fallbacks.geo
```

---

## 16. Tool Inheritance

Tools can extend other tools to override or add wires:

```bridge
tool baseApi from httpCall {
  with context
  .baseUrl = "https://api.example.com"
  .headers.Authorization <- context.token
}

tool baseApi.users from baseApi {
  .path = /users
  .method = GET
}

tool baseApi.createUser from baseApi {
  .path = /users
  .method = POST
}
```

### Merge rules

When a child extends a parent:

1. **Function** — inherited from the root ancestor.
2. **Dependencies** — merged (child can add new deps; duplicates by handle are
   deduped).
3. **Wires** — child overrides parent wires with the same target. The child's
   wire completely replaces the parent's wire for that target key. All other
   parent wires are inherited as-is.

---

## 4. Const Blocks

Named constants available across all bridges and tools in the file:

```bridge
const fallbackGeo = { "lat": 0, "lon": 0 }
const defaultCurrency = "EUR"
const maxRetries = 3
```

Values are JSON. Multi-line objects and arrays are supported:

```bridge
const config = {
  "timeout": 5000,
  "retries": 3
}
```

Access constants via `with const as c`, then `c.fallbackGeo.lat`.

---

## 5. Define Blocks

Defines are reusable subgraphs — think of them as macros that get inlined into
the bridge at parse time:

```bridge
define secureProfile {
  with userApi as api
  with input as i
  with output as o

  api.id <- i.userId
  o.name <- api.login
  o.email <- api.email
}
```

Use in a bridge:

```bridge
bridge Query.me {
  with secureProfile as profile
  with input as i
  with output as o

  profile.userId <- i.id
  o.name <- profile.name
}
```

---
