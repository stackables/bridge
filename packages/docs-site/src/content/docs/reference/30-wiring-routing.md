---
title: Wiring & Routing
description: The Bridge Language — Definitive Guide
---

## 6. Wires — The Core Primitive

Wires are the fundamental building block. Every wire has a **target** (left
side) and a **source** (right side), connected by `<-`:

```bridge
target <- source
```

The engine is **pull-based**: when GraphQL demands a field, the engine traces
backward through wires to find and resolve the data.

### Constant wires

```bridge
o.country = "Germany"
```

Set a fixed value. Constants always win over pull wires — if both exist for the
same target, the constant is returned immediately without triggering any tool
calls.

### Pull wires

```bridge
o.city <- geo.items[0].name
```

Resolve the source at runtime. If the source is a tool, the engine schedules
the tool call, waits for the result, and drills into the response path.

---

## 15. Path Scoping Blocks (Nested Objects)

When wiring deeply nested objects, repeating long path prefixes gets tedious
and obscures the logical structure:

```bridge
api.body.user.profile.id <- i.id
api.body.user.profile.name <- i.name
api.body.user.settings.theme = "dark"
api.body.user.settings.notifications = true
```

Path scoping blocks let you factor out the common prefix:

```bridge
api.body.user {
  .profile {
    .id <- i.id
    .name <- i.name
  }
  .settings {
    .theme = "dark"
    .notifications = true
  }
}
```

### Syntax

```
<target> {
  .<field> = <value>         # constant wire
  .<field> <- <source>       # pull wire (with all modifiers)
  .<field> {                 # nested scope (recursive)
    ...
  }
}
```

The `<target>` is any valid address path (handle, handle.path, etc.). Each
inner line starts with a dot (`.`) just like array-mapping element lines.

### How it works

Path scoping is **purely syntactic sugar**. The parser flattens each inner
line by prepending the parent path, producing exactly the same wires as the
long-form version. The engine never knows a block was used.

### Full feature support

All wire features work inside scope blocks:

```bridge
api.body {
  .name <- uc:i.name                    # pipe chains
  .cents <- i.dollars * 100             # inline expressions
  .tier <- i.isPro ? "premium" : "basic" # ternary
  .label <- "Hello, {i.name}!"          # string interpolation
  .fallback <- i.primary || i.secondary  # null coalesce
  .safe <- i.value ?? 0                  # error coalesce
}
```

### Nesting depth

Blocks can nest arbitrarily deep:

```bridge
api.request {
  .method = "POST"
  .body {
    .user {
      .profile {
        .name <- i.name
      }
    }
  }
}
```

This is equivalent to `api.request.body.user.profile.name <- i.name` plus the
constant `api.request.method = "POST"`.

### Mixing flat and scoped wires

Flat wires and scope blocks can coexist in the same bridge body:

```bridge
bridge Mutation.createUser {
  with std.httpCall as api
  with input as i
  with output as o

  api.method = "POST"
  api.body {
    .name <- i.name
    .email <- i.email
  }
  o.success = true
}
```

---

## 17. Force Statement (`force <handle>`)

The `force` statement eagerly schedules a tool for execution, even if no output
field demands its data. Use it for side effects — audit logging, analytics,
cache warming.

A bare `force` is **critical**: if the forced tool throws, the error propagates
into the response just like a regular tool failure.

```bridge
bridge Query.search {
  with searchApi as s
  with audit.log as audit
  with input as i
  with output as o

  s.q <- i.q
  audit.action <- i.q
  force audit            # critical — error breaks the response
  force audit ?? null.   # fire-and-forget — errors are silently swallowed
  o.title <- s.title
}
```

---
