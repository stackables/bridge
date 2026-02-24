
## Resolution Signals (`2.1`)

**Target Version:** 2.1

**Status:** Design Phase

**Core Goal:** Provide declarative control-flow keywords to handle "all-is-lost" scenarios and dynamic array pruning.

### 1. The "Why"

Currently, The Bridge handles missing data (`||`) and errors (`??`) by falling back to other values. However, some scenarios require **stopping** instead of **falling back**.

* **`throw`** solves the "Silent Failure" problem where a null value might propagate through the system when it should have triggered a hard stop with a meaningful message.
* **`continue`** solves the "Deep Filtering" problem, allowing iterations to be discarded based on runtime failures or missing data without crashing the entire request.

---

### 2. Functional Specification

#### **The `throw` Signal**

The `throw` keyword can be used as the final argument in a fallback chain. It upgrades a data state into a high-level execution error.

* **Syntax:** `source || throw "message"` or `source ?? throw "message"`
* **Behavior:** * If used with `||`: Triggers if all preceding sources are `null` or `undefined`.
* If used with `??`: Triggers if the preceding source throws a technical error (timeout, 500, etc.).


* **Result:** Aborts the current request and returns a formatted GraphQL error.

#### **The `continue` Signal**

The `continue` keyword is a specialized signal available only within **Shadow Scopes** (Array Mapping blocks). It acts as a "silent skip."

* **Syntax:** `source || continue` or `source ?? continue`
* **Behavior:**
* Immediately halts all pending wires for the **current iteration only**.
* Excludes the current element from the final resulting array.


* **Result:** The parent array is returned "compacted" (shorter than the source array).

---

### 3. Usage Examples

#### **Contract Enforcement with `throw**`

```bridge
bridge Query.userProfile {
  with userApi as api
  with output as o

  # Guarantee data integrity: if the API returns null, don't return an empty object,
  # return a human-readable error.
  o.username <- api.profile.name || throw "User profile is incomplete or missing"

  # Wrap a technical timeout in a business-friendly error
  o.balance <- api.account.balance ?? throw "Financial service is temporarily unavailable"
}

```

#### **Dynamic Pruning with `continue**`

```bridge
o.activePromotions <- api.promos[] as p {
  # 1. If the promo has no expiration date, skip it.
  .expiry <- p.expires_at || continue

  # 2. If the validation API fails for this specific promo, skip it.
  alias promoService.check:p.id as status ?? continue
  
  .code <- p.code
  .discount <- status.value
}

```

---

### 4. Implementation Details

#### **The "Signal" Bubble**

When the engine encounters `throw` or `continue`, it doesn't return a value; it emits a **Signal**.

1. **`throw`** bubbles all the way to the **Bridge Boundary**. The engine catches it and terminates the entire GraphQL execution.
2. **`continue`** bubbles only to the nearest **Iterator Boundary**. The engine catches it, cancels any parallel wires still pending for that specific index (saving I/O), and marks that index as "discarded."

#### **Parser Requirements**

* Keywords must be reserved.
* `continue` must trigger a linting error if used outside a `bridge ... { ... [] as it { ... } }` block.
* `throw` must allow an optional string literal for custom error messages.

---

### 5. Material Benefits

* **Resilience:** API consumers get clear, actionable errors instead of mysterious `null` fields.
* **Clean Responses:** Frontend developers no longer need to write `.filter(x => x !== null)` in their components; the array comes back pre-cleaned.
* **I/O Efficiency:** `continue` allows the engine to cancel pending network requests for a discarded iteration as soon as the failure is hit.

---

Would you like me to move on to the **Mathematics & Logic** (`std.math`) documentation, or shall we dive into how **Server Context** (`with context`) works in 2.0?
