
## Native Batching & Tool Consolidation 

**Target Version:** 2.x

**Status:** In Design (Supported in Userland), Needs syntax change

**Core Goal:** Solve the N+1 problem at the engine level, allowing tools to process arrays of inputs without manual DataLoader setup.


### 1. The Current State: Userland Batching

Currently, developers can solve N+1 issues by injecting a `DataLoader` into the `context`. This works because the Bridge engine executes shadow trees concurrently.

**How it works today:**

1. **Instantiate:** A `DataLoader` is created per request and added to the context.
2. **Tool Call:** The engine calls a tool 100 times for an array of 100 items.
3. **Intercept:** The tool function receives the scalar input (e.g., `{ id: "1" }`) and manually calls `loader.load(id)`.
4. **Resolve:** The DataLoader batches these calls into one DB/API request.


### 2. The Future: Native `.batch` Support (v2.1)

We plan to eliminate the need for manual DataLoader management by allowing tools to declare a "Batching Contract."

**The Proposal:**
Introduce a `.batch` property in the tool definition. When enabled, the engine changes the execution contract from **Scalar** (1 input -> 1 output) to **Plural** (N inputs -> N outputs).

```bridge
# Bridge Definition (2.1)
tool getUsers from db.fetch {
  .batch = true
  .maxBatchSize = 100
}

```

**Potential langauge change**: this will conflict with a tool parameter `.batch` and needs some special handling. making it a much bigger change

#### **The User Experience (Clean Implementation)**

The developer no longer needs to know about "Loaders" or "Context." They simply write a function that handles an array of inputs.

```typescript
// The new "Plural" Tool Implementation
export const fetchUsers = async (calls: Array<{ input: any, context: any }>) => {
  const ids = calls.map(c => c.input.id);
  
  // Single DB call for the entire batch
  const users = await db.users.findMany({ where: { id: { in: ids } } });
  
  // Return array in same order as input
  const userMap = new Map(users.map(u => [u.id, u]));
  return ids.map(id => userMap.get(id));
};

```


### 3. Engine Implementation: The Batching Buffer

To support this, the `ExecutionTree` will be upgraded with a **Microtask Buffer**.

1. **Queueing:** When `callTool` hits a `.batch = true` tool, it generates a unique promise and pushes the input into a "Wait Room" for that tool.
2. **The Flush:** The engine uses `process.nextTick` or `setImmediate` to wait for the current execution cycle to finish gathering all parallel requests.
3. **Execution:** The engine flushes the "Wait Room," calls the tool implementation once with the gathered array, and then resolves the 100 individual promises with the resulting data.


### 4. Comparison of Approaches

| Feature | Userland (2.0) | Native (2.1) |
| --- | --- | --- |
| **Tool Code** | Imperative (`loader.load`) | Declarative (Pure Logic) |
| **Setup** | Manual per-request context | Automatic via Bridge config |
| **Observability** | OTel sees 100 separate "Tool" spans | OTel sees one "Batch Tool" span |
| **Safety** | User must manage cache isolation | Engine ensures per-request isolation |
