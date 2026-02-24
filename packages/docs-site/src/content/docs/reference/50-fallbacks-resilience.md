---
title: Fallbacks & Resilience
description: The Bridge Language — Definitive Guide
---

## 7. Fallback Chains: `||` and `??`

Bridge supports two fallback operators for building resilient data pipelines.

### `||` — Null coalesce (value guard)

Fires when the source resolves successfully but returns `null` or `undefined`.

```bridge
o.name <- api.name || "Anonymous"
```

**Execution:** The engine evaluates sources **left to right, sequentially**. It
stops at the first non-null result. Sources to the right of the winner are
**never called**.

```bridge
# If primaryApi returns non-null → done. backupApi is never called.
# If primaryApi returns null → try backupApi.
# If both return null → use "unknown".
o.label <- primaryApi.label || backupApi.label || "unknown"
```

This is critical for cost control. If `primaryApi` succeeds, the engine does
not waste a network call on `backupApi`.

**Important:** `||` does **not** catch errors. If `primaryApi` throws, the
entire chain throws (unless you also add `??`).

### `??` — Error coalesce (error guard)

Fires when the source throws an error (network failure, 500, timeout, etc.).

```bridge
o.lat <- api.lat ?? 0
o.label <- api.label ?? i.fallbackLabel
```

The `??` tail is evaluated only when everything before it throws.

### Combined chains

You can combine both operators in a single wire:

```bridge
o.label <- api.label || backup.label || "default" ?? i.errorFallback
```

Reading order:

1. Try `api.label` — if non-null, return it.
2. Try `backup.label` — if non-null, return it.
3. Both null? Return `"default"`.
4. Any of the above threw? Return `i.errorFallback`.

The `??` guard wraps the entire `||` chain. If _any_ source throws during
sequential evaluation, the engine jumps to the `??` fallback.

### Pipe transforms in fallbacks

You can apply a pipe transform to the `??` fallback:

```bridge
o.label <- api.label ?? upperCase:i.errorDefault
```

If `api` throws, the engine takes `i.errorDefault` and passes it through the
`upperCase` tool before returning it.

---

## 8. Overdefinition — Multiple Wires to the Same Target

You can wire the same output field from multiple **separate lines**:

```bridge
o.textPart <- i.textBody
o.textPart <- upperCase:i.htmlBody
```

This is called **overdefinition**. When multiple wires target the same field,
they form an implicit coalesce group.

### Cost-aware resolution

The engine does not blindly race all sources. Instead, it sorts them by
**estimated cost** and evaluates them cheapest-first:

| Cost tier        | Sources                     | Why                                         |
| ---------------- | --------------------------- | ------------------------------------------- |
| **Free** (0)     | `input`, `context`, `const` | Pure memory reads, no I/O                   |
| **Computed** (1) | Tool calls, pipes, defines  | Require scheduling and possible network I/O |

The engine:

1. Sorts the wires by cost tier (free sources first).
2. Evaluates them sequentially.
3. Returns the first non-null result.
4. Never calls expensive sources if a cheap one already has data.

**Example:**

```bridge
o.city <- i.city            # Cost 0: free (direct input read)
o.city <- geo.cityName      # Cost 1: expensive (HTTP geocoding call)
```

If the user provided `city` in the GraphQL arguments, the engine returns it
immediately. The geocoding API is never called.

This is the same short-circuit behavior as `||`, but determined by the engine
automatically based on source cost rather than by the order you wrote the
wires.

### When to use overdefinition vs `||`

| Pattern                                        | Use when...                                          |
| ---------------------------------------------- | ---------------------------------------------------- |
| `o.x <- a.x \|\| b.x`                          | You want explicit priority: try A, then B            |
| Two lines: `o.x <- cheap` / `o.x <- expensive` | The engine should pick the cheapest available source |

For overdefinition, **wire order in the file does not matter** — the engine
always evaluates cheapest first. For `||` chains, **order matters** — the
engine follows your declared priority left to right.

---
