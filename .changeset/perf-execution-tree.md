---
"@stackables/bridge-core": patch
---

Performance: execution engine optimisations (+44–130% on array benchmarks, +7–9% on tool-heavy workloads)

- Lightweight shadow tree construction — bypass constructor for per-element shadow trees, copying pre-computed fields from parent instead of re-deriving them (+5–7% on array benchmarks)
- Skip OpenTelemetry span overhead when no tracer is configured — lazy-probe once on first tool call, take a direct fast path when OTel is no-op (+7–9% on tool-heavy benchmarks)
- Pre-group element wires once per `materializeShadows` call instead of re-filtering per element per field
- Flatten nested `Promise.all(N × Promise.all(F))` to a single flat `Promise.all(N×F)` for direct-field arrays, eliminating microtask scheduling overhead (+44–130% on flat arrays, +14–43% on nested arrays)
- Cache element trunk key — pre-compute `trunkKey({ ...trunk, element: true })` once per tree instead of per call
- Cache `coerceConstant()` results — module-level Map avoids redundant JSON.parse across shadow trees
- Replace `pathEquals` `.every()` with a manual for-loop
