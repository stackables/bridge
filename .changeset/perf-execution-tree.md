---
"@stackables/bridge-core": patch
---

Performance: execution engine optimisations (+10–15% overall, +7–9% on tool-heavy workloads)

- Lightweight shadow tree construction — bypass constructor for per-element shadow trees, copying pre-computed fields from parent instead of re-deriving them (+5–7% on array benchmarks)
- Skip OpenTelemetry span overhead when no tracer is configured — lazy-probe once on first tool call, take a direct fast path when OTel is no-op (+7–9% on tool-heavy benchmarks)
- Cache element trunk key — pre-compute `trunkKey({ ...trunk, element: true })` once per tree instead of per call
- Cache `coerceConstant()` results — module-level Map avoids redundant JSON.parse across shadow trees
- Replace `pathEquals` `.every()` with a manual for-loop
