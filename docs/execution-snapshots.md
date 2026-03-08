# Traversal IDs

This document explains the reduced version of the feature.

The goal is now simple:

- produce one concise id per execution
- make that id depend on the actual path taken through the bridge
- use it to group executions into monitoring buckets
- do not expose large debug payloads as part of the public API

## Public Surface

### Standalone / Core

```ts
const result = await executeBridge({
  document,
  operation: "Query.lookup",
  input: { q: "x" },
  traversalId: true,
  tools,
});

result.traversalId;
```

Static planning API:

```ts
const plans = enumerateTraversalIds(bridge);

for (const plan of plans) {
  console.log(plan.traversalId, plan.sites);
}
```

That planner is the auditable static view of the problem: every bridge has a finite set of informative traversal buckets, and execution picks one of them.

Returned shape:

```ts
type ExecuteBridgeResult<T> = {
  data: T;
  traces: ToolTrace[];
  traversalId?: string;
};
```

### GraphQL

```ts
const schema = bridgeTransform(baseSchema, document, {
  tools,
  traversalId: true,
});
```

When enabled, GraphQL responses include:

```json
{
  "extensions": {
    "traversalId": "path_..."
  }
}
```

Programmatic access:

```ts
const traversalId = getBridgeTraversalId(context);
```

## Meaning

`traversalId` is a deterministic fingerprint of the informative path that actually executed through the bridge.

It is intended for grouping executions by runtime path, not for representing the exact request payload.

The important part is informative.

Deterministic passthrough/config wires that cannot change the execution class are ignored.

Examples:

- `api.from <- i.from`
- `api.to <- i.to`
- `.provider = "SBB"`

Those wires may still be required for execution, but they do not add branching information, so they do not contribute to the traversal id.

That means:

- same path through the graph => same `traversalId`
- different path through the graph => different `traversalId`
- repeated loop iterations with the same branch outcomes => same `traversalId`
- adding or removing deterministic non-branching wires does not change `traversalId`

Input values are only relevant when they cause a different path to be taken.

For array-heavy bridges, the id intentionally generalises over cardinality.

If a mapped array returns 2 items or 20 items, that alone should not create a different traversal group. What matters is whether execution encountered different branch outcomes such as fallback, catch, nullish/falsy gates, and so on.

## Branch Sites

The traversal model now treats a bridge as a set of informative branch sites.

A branch site is usually one of these:

- a wire with `||` or `??`
- a wire with `catch`
- a conditional wire
- a safe wire where success vs swallowed error changes the path
- a simple wire that participates in overdefinition against other wires to the same target

Each site contributes only the branch outcomes that actually occurred.

For repeatable sites inside array mappings, the runtime records the set of outcomes that appeared at least once, not how many times each one appeared.

This is what makes the permutation space easy to reason about statically.

For example, a repeatable site with two possible outcomes contributes three observable states:

1. first outcome only
2. second outcome only
3. both outcomes observed somewhere in the loop

That is the model used by the new large-bridge unit test.

## Example

Given:

```bridge
bridge Query.lookup {
  with primary as p
  with backup as b
  with catcher as c
  with input as i
  with output as o

  p.q <- i.q
  b.q <- i.q
  c.q <- i.q
  o.label <- p.label || b.label catch c.label
}
```

These executions should fall into different traversal groups:

1. `p.label` succeeds
2. `p.label` falls through to `b.label`
3. `p.label` throws and `c.label` is used

Those three cases now produce different `traversalId` values.

Two requests that both take case 1 should produce the same `traversalId` even if the concrete input payload differs.

## What Is Not Public API

The public API is only the final id.

These are internal details and should not be treated as contract:

- how the engine identifies branch sites internally
- the exact hash algorithm
- the exact internal token format used before hashing
- the current compiler fallback to the interpreter when `traversalId: true` is requested

## Compiler Behavior

The compiled executor accepts the same `traversalId: true` option.

Today it falls back to the interpreter to compute the id, so the API stays consistent while the implementation remains correct.

That fallback is plumbing, not the feature.

## Playground

The playground now always computes and shows the traversal id in the result panel.

That makes it easy to compare executions interactively and verify that different fallback or catch paths map into different monitoring groups.

## Path Reconstruction Later

This feature intentionally does not expose a full per-wire path trace.

If we later need to recover a human-readable path, that should be treated as a separate concern.

Given the bridge file and the traversal id generation rules, it should be possible to derive or brute-force the matching path offline without forcing every execution result to carry large debug payloads.

The new unit test demonstrates this on a larger train-search bridge by enumerating its informative branch-site permutations and verifying that each permutation maps to a distinct traversal id.

## Review Questions

These are the questions that matter now:

1. Is one `traversalId` enough for the monitoring use case?
2. Does the current id change exactly when the runtime path changes?
3. Is interpreter fallback acceptable for compiled mode in the first version?
4. Do we want the playground to show only the id, or also add copy/export affordances later?

## Summary

The feature is now intentionally narrow.

It exposes one thing:

- `traversalId`

That id is meant to group executions by actual runtime path through the bridge, without exposing debug-heavy execution collections in the public result shape.
