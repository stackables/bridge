---
"@stackables/bridge-core": minor
"@stackables/bridge-compiler": minor
---

Sync tool optimisation — honour the `sync` flag in ToolMetadata

When a tool declares `{ sync: true }` in its `.bridge` metadata the engine
now enforces and optimises it:

1. **Enforcement** — if a sync-declared tool returns a Promise, both the
   runtime and compiled engines throw immediately.
2. **Core optimisation** — `callTool()` skips timeout racing, the OTel span
   wrapper, and all promise handling for sync tools.
3. **Compiler optimisation** — generated code uses a dedicated `__callSync()`
   helper at every call-site, avoiding `await` overhead entirely.
4. **Array-map fast path** — when all per-element tools in an array map are
   sync, the compiled engine generates a dual-path: a synchronous `.map()`
   branch (no microtask ticks) with a runtime fallback to `for…of + await`
   for async tools.

Benchmarks show up to ~50 % latency reduction for compiled array maps
with sync tools (100 elements).
