---
"@stackables/bridge-core": patch
---

Performance: execution engine optimisations (+60–129% on array benchmarks, +4–16% across all benchmarks)

- Lightweight shadow tree construction — bypass constructor for per-element shadow trees, copying pre-computed fields from parent instead of re-deriving them (+5–7% on array benchmarks)
- Skip OpenTelemetry span overhead when no tracer is configured — lazy-probe once on first tool call, take a direct fast path when OTel is no-op (+7–9% on tool-heavy benchmarks)
- Pre-group element wires once per `materializeShadows` call instead of re-filtering per element per field
- Flatten nested `Promise.all(N × Promise.all(F))` to a single flat `Promise.all(N×F)` for direct-field arrays, eliminating microtask scheduling overhead (+44–130% on flat arrays, +14–43% on nested arrays)
- Maybe-Async sync fast path — `pullSingle` returns synchronously when value is already in state, `resolveWires` detects single no-modifier wires and skips async entirely, `materializeShadows` avoids `Promise.all` when all values are synchronous; eliminates 6000–7000 microtask queue entries per 1000-element array (+42–114% on array benchmarks, +8–19% across all benchmarks)
- Pre-compute keys and cache wire tags — cache `trunkKey` on NodeRef objects via `??=`, hoist pathKey computation out of N×F loop, cache simple-pull-wire detection on wire objects, cap `constantCache` at 10K entries (+60–129% on arrays, +4–16% across all benchmarks)
- Cache element trunk key — pre-compute `trunkKey({ ...trunk, element: true })` once per tree instead of per call
- Cache `coerceConstant()` results — module-level Map avoids redundant JSON.parse across shadow trees
- Replace `pathEquals` `.every()` with a manual for-loop
