---
title: Expressions & Formatting
description: The Bridge Language — Definitive Guide
---

## 12. Inline Expressions

Perform arithmetic and comparison operations directly in wire assignments:

```bridge
o.cents <- i.dollars * 100
o.total <- i.price * i.quantity
o.eligible <- i.age >= 18
o.isActive <- i.status == "active"
```

### Supported operators

| Category   | Operators                   | Description                     |
| ---------- | --------------------------- | ------------------------------- |
| Arithmetic | `*` `/` `+` `-`             | Multiply, divide, add, subtract |
| Comparison | `==` `!=` `>` `>=` `<` `<=` | Returns `true` or `false`       |

### Operator precedence

Standard math precedence applies:

1. `*` `/` — highest precedence (evaluated first)
2. `+` `-` — medium precedence
3. `==` `!=` `>` `>=` `<` `<=` — lowest precedence (evaluated last)

```bridge
o.total <- i.base + i.tax * 2       // = i.base + (i.tax * 2)
o.flag  <- i.price * i.qty > 100    // = (i.price * i.qty) > 100
```

### Chained expressions

Multiple operators can be chained:

```bridge
o.result <- i.times * 5 / 10
o.flag   <- i.times * 2 > 6
```

### Expressions with fallbacks

Expressions work with `||` (null coalesce) and `??` (error coalesce):

```bridge
o.cents <- api.price * 100 ?? -1
```

If `api.price` throws, the `??` fallback catches the error and returns `-1`.

### Operand types

The right-hand operand of each operator can be:

- **Number literal**: `100`, `1.2`, `-5`
- **String literal**: `"active"` (for equality comparisons)
- **Boolean literal**: `true` (coerced to `1`), `false` (coerced to `0`)
- **Source reference**: `i.quantity`, `api.price`

### Non-number handling

All arithmetic operands are coerced via JavaScript `Number()`:

| Input              | Coerced to | Example               |
| ------------------ | ---------- | --------------------- |
| `null`             | `0`        | `null * 100 = 0`      |
| `undefined`        | `NaN`      | `undefined + 5 = NaN` |
| Numeric string     | Number     | `"10" * 5 = 50`       |
| Non-numeric string | `NaN`      | `"hello" + 1 = NaN`   |

Comparison operators with `NaN` always return `false`.

### Expressions in array mapping

Expressions work inside `[] as iter { }` element blocks:

```bridge
o.items <- api.items[] as item {
  .name  <- item.name
  .cents <- item.price * 100
}
```

### How it works

Expressions are **syntactic sugar**. The parser desugars them into synthetic
tool forks using the built-in `math` namespace tools. The execution engine
never sees expression syntax — it processes standard pull and constant wires.

For example, `o.total <- i.price * i.qty` becomes:

```
Wire: i.price → math.multiply.a
Wire: i.qty   → math.multiply.b
Wire: math.multiply → o.total
```

---

## 13. Conditional Wire (`? :`)

Select between two sources based on a boolean condition. Only the chosen
branch is evaluated — the other branch is never touched.

```bridge
o.amount <- i.isPro ? i.proPrice : i.basicPrice
```

### Syntax

```
<target> <- <condition> ? <then> : <else>
```

- **`condition`** — any source reference or expression (e.g. `i.flag`, `i.age >= 18`)
- **`then`** — source reference or literal (string, number, boolean, null)
- **`else`** — source reference or literal

### Literal branches

```bridge
o.tier     <- i.isPro ? "premium" : "basic"
o.discount <- i.isPro ? 20 : 5
o.active   <- i.isPro ? true : false
```

### Expression conditions

The condition can be a full expression, including comparisons:

```bridge
o.result <- i.age >= 18 ? i.adultPrice : i.childPrice
o.flag   <- i.score * 2 > 100 ? "pass" : "fail"
```

### Combining with fallbacks

`||` (null-coalesce) and `??` (error-coalesce) can follow the ternary:

```bridge
# || fires when the chosen branch is null/undefined
o.price <- i.isPro ? i.proPrice : i.basicPrice || 0

# ?? fires when the chosen branch throws
o.price <- i.isPro ? proTool.price : basicTool.price ?? -1

# || with a source reference
o.price <- i.isPro ? i.proPrice : i.basicPrice || fallback.getPrice
```

### Inside array mapping

```bridge
o.items <- api.results[] as item {
  .name  <- item.name
  .price <- item.isPro ? item.proPrice : item.basicPrice
}
```

### Semantics

The engine evaluates the **condition first** (benefiting from the cost-0
fast-path for input/context reads). It then pulls **only the chosen branch**
— the other branch is never scheduled, preventing unnecessary tool calls.

---

## 14. String Interpolation

String interpolation lets you build strings from multiple sources using `{…}`
placeholders inside quoted strings on the right-hand side of a pull wire (`<-`).

```bridge
bridge Query.userOrders {
  with ordersApi as api
  with input as i
  with output as o

  # REST URL construction
  api.path <- "/users/{i.id}/orders"

  # Assembling display text
  o.name <- "{i.firstName} {i.lastName}"
  o.greeting <- "Hello, {i.firstName}!"
}
```

### Syntax

A string on the RHS of `<-` is scanned for `{…}` placeholders. If any are
found, the string becomes a template — the engine resolves each placeholder
at runtime and concatenates the result.

Placeholders reference the same source addresses used in regular pull wires:
`i.field`, `api.field`, `ctx.field`, alias names, etc.

```bridge
o.url     <- "/api/{api.version}/items/{i.itemId}"
o.display <- "{i.first} {i.last}"
```

### Constant wires are not interpolated

The `=` operator assigns verbatim — no interpolation:

```bridge
o.path = "/users/{id}"       # literal string, braces kept as-is
o.path <- "/users/{i.id}"    # template — {i.id} is resolved
```

### Non-string values

Placeholder values are coerced to strings at runtime:

| Source value         | Interpolated as     |
| -------------------- | ------------------- |
| `"hello"`            | `hello`             |
| `42`                 | `"42"`              |
| `true`               | `"true"`            |
| `null` / `undefined` | `""` (empty string) |

### Escaping

Use `\{` to include a literal brace in a template string:

```bridge
o.json <- "\{key: {i.value}}"    # produces: {key: someValue}
```

### Inside array mapping

Template strings work inside `[] as iter { }` blocks:

```bridge
o <- api.items[] as it {
  .url   <- "/items/{it.id}"
  .label <- "{it.name} (#{it.id})"
}
```

### Combining with fallbacks

Templates support `||` (null coalesce) and `??` (error coalesce):

```bridge
o.greeting <- "Hello, {i.name}!" || "Hello, stranger!"
```

### How it works

Under the hood, the parser desugars template strings into a synthetic
`std.concat` fork — the same pattern used by pipes and inline expressions.
The engine never learns about template strings; it just resolves tool
inputs, calls `std.concat`, and wires the result to the target.

---
