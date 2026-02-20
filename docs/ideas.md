## 1. The "Switch-Board" Approach

In a pull-based system, an `if` is essentially a **conditional wire**. Instead of a single source, a field has multiple potential sources gated by a predicate.

**How it looks in the syntax:**

```hcl
define smartPrice {
  with stripe
  with output as o
  with input as i

  # The engine doesn't "run" the if. 
  # It checks the condition ONLY when 'o.amount' is requested.
  o.amount <- i.isPro ? stripe.proPrice : stripe.basicPrice
}

```

## 2. Lazy Branching

The key to making this work in your engine is that the **condition itself is a pull**.

1. The GraphQL query asks for `amount`.
2. The engine looks at the wire: `i.isPro ? A : B`.
3. The engine pulls `i.isPro` first.
4. **Crucially:** Depending on that result, it pulls *either* `A` *or* `B`. It never touches the other branch.

## 3. The "Conditional Block" (Scoped Wiring)

If you want to gate multiple fields at once, you can use a block syntax. This isn't "execution flow"; it's **conditional visibility**.

```hcl
bridge Query.user with secureUser {
  # These wires only exist for the resolver if the condition is met
  if context.isAdmin {
    o.internalNote <- api.notes
    o.lastIp       <- api.ip
  }
}

```

In this model, if `context.isAdmin` is false, the engine treats `o.internalNote` as if it were never defined (returning `null` or an error, depending on your schema).

In a standard programming language, an `if` statement is a jump in the instruction pointer. In **The Bridge**:

* **It’s a Gate:** It determines which part of the graph is "live" for a specific request.
* **It’s Demand-Driven:** The condition is only evaluated if someone asks for a field inside the conditional block.
* **It’s Stateless:** The `if` doesn't change a variable; it just selects a source.
