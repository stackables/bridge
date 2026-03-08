---
"@stackables/bridge": minor
"@stackables/bridge-core": minor
"@stackables/bridge-graphql": minor
"@stackables/bridge-compiler": minor
---

Add opt-in traversal ids for bridge runs.

`executeBridge()` now accepts `traversalId: true` and returns a stable traversal fingerprint for the informative runtime path taken through the bridge. Deterministic passthrough/config wires are ignored, while fallback/catch/conditional branch sites still contribute. Repeatable branch sites are grouped by which outcomes occurred, not by iteration count. GraphQL integrations expose the same value through `extensions.traversalId` and `getBridgeTraversalId(context)`.
