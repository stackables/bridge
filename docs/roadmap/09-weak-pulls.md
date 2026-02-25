## Opportunistic Overrides (The `<~` Operator)

**Target Version:** 2.1

**Status:** Architectural Design

**Core Goal:** Prevent accidental over-fetching by introducing "Weak Edges" that passively observe data rather than actively triggering tool execution.


### 1. The Problem: The "Blind Resolver" Trap

In standard GraphQL architecture, resolvers are blind to each other. If a minor UI component (like a Header) needs a localized city name, it might accidentally trigger an expensive backend HTTP call to a geocoding service.

We want the Header to say: *"Use the cheap user input by default. But if another component on this page already woke up the Geocoding API, I want to steal that accurate data."*

### 2. The Solution: Strong vs. Weak Pulls

We introduce a new edge operator (`<~`) to represent an **Opportunistic Override**.

* **`<-` (Strong Pull):** The Driver. "I demand this data. Engine, schedule and execute this tool."
* **`<~` (Weak Pull):** The Observer. "I am listening. If this tool is executed by someone else, intercept the result and overwrite my value. Otherwise, do nothing."

### 3. Syntax & Priority

The engine evaluates overrides **top-down**. The last successful override wins.

```bridge
bridge Query.dashboard {
  with upper
  with input as i
  with output as o

  # 1. THE BASE (Strong Pull)
  # This always runs. It uses the cheap user input or a fallback string.
  o.cityUpperCase <- upper:i.cityName || "NARNIA"

  # 2. OPPORTUNISTIC OVERRIDE (Weak Pull)
  # This does NOT trigger the geocode tool. 
  # It only applies if another GraphQL field requested 'geocodeFirstResult'.
  o.cityUpperCase <~ upper:geocodeFirstResult.display_name

  # 3. HIGHEST PRIORITY OVERRIDE (Weak Pull)
  # Overrides everything above it, but only if 'accurateGPS' was triggered.
  o.cityUpperCase <~ upper:accurateGPS.display_name
}

```

### 4. Engine Mechanics (The "Settle Phase")

To implement this without Race Conditions, the `ExecutionTree` will introduce a 3-tick evaluation cycle:

1. **Tick 1 (Execution):** The engine fires all tools required by Strong Pulls (`<-`) across the entire GraphQL request context.
2. **Tick 2 (Observation):** The engine evaluates all Weak Pulls (`<~`).
* If the target tool is **Not Pending**, the weak edge is instantly discarded.
* If the target tool is **Pending**, the engine attaches a listener (`.then()`) to the pending promise.


3. **Tick 3 (Mutation):** As the pending tools resolve, the weak edges trigger their local mutations (e.g., running the `upper` tool) and overwrite the output values right before the final JSON payload is sent to the client.
