
## Execution Safety & Lifecycle (`2.1`)

**Target Version:** 2.1

**Status:** Research / Architectural Design

**Core Goal:** Implement a robust safety layer to prevent resource exhaustion and provide deterministic graph termination.

---

### 1. The "Why"

As The Bridge moves toward complex microservice orchestration, two risks emerge:

1. **Zombie Requests:** If a mobile user loses connection, the engine currently keeps firing expensive back-end API calls because the "Pull" has already been triggered.
2. **Graph Recursion:** A misconfigured `define` block or a circular bridge reference could theoretically cause the engine to loop infinitely, crashing the node process.

---

### 2. Functional Specification

#### **A. Native Cancellation Tokens**

The engine will implement an internal `CancellationToken` that is passed through every node in the execution tree.

* **Behavior:** Every `std.httpCall` or long-running tool will be registered with the token.
* **Trigger:** If the client disconnects (HTTP `close` event) or a `throw` signal is hit in another branch, the token is canceled.
* **Result:** All pending I/O for that request is immediately aborted at the socket level.

#### **B. Depth Control (The "Safety Ceiling")**

To prevent deep nesting or accidental recursion from consuming the entire stack, we introduce a `maxDepth` configuration.

* **Mechanism:** Each time a `define` block or a nested array mapping is entered, a depth counter increments.
* **Limit:** If the counter exceeds the pre-defined limit (e.g., 25 levels), the engine emits a `throw` signal: *"Maximum graph depth exceeded."*

#### **C. Circular Dependency Detection**

The engine will perform a **Static Cycle Analysis** during the parse phase.

* **Static:** The compiler will build a Directed Acyclic Graph (DAG) and fail the build if a `define` block references itself.


### 5. Material Benefits

* **Cost Savings:** No more paying for API calls that the user will never see because they navigated away.
* **Predictability:** Guarantees that the engine can never enter an infinite loop, regardless of how complex the `.bridge` files become.
* **Stability:** Protects the server memory and CPU from "Complex Query Attacks" where a client sends a request designed to trigger maximum graph depth.
