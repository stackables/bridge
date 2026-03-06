---
"@stackables/bridge-core": patch
"@stackables/bridge-compiler": patch
---

Fix AOT/runtime parity for null element traversal, catch-null recovery, and non-array source handling

**bridge-core:**

- `catch` gate now correctly recovers with an explicit `null` fallback value.
  Previously, `if (recoveredValue != null)` caused the catch gate to rethrow
  the original error when the fallback resolved to `null`; changed to
  `!== undefined` so `null` is treated as a valid recovered value.

- Element refs (array-mapping `el.field` references) are now null-safe during
  path traversal. When an array element is `null` or `undefined`, the runtime
  returns `undefined` instead of throwing `TypeError`, matching AOT-generated
  code which uses optional chaining on element accesses.

- Array-mapping fields (`resolveNestedField`) now return `null` when the
  resolved source value is not an array, instead of returning the raw value
  unchanged. This aligns with AOT behavior and makes non-array source handling
  consistent.

**bridge-compiler:**

- AOT-generated code now respects `rootSafe` / `pathSafe` flags on input refs,
  using strict property access (`["key"]`) instead of optional chaining
  (`?.["key"]`) for non-safe segments. Previously all input-ref segments used
  optional chaining regardless of flags, silently swallowing TypeErrors that
  the runtime would throw.

- Array-mapping expressions now guard the source with `Array.isArray` before
  calling `.map` / `.flatMap`. Previously, a non-array non-null source
  (e.g. a string) would cause a `TypeError` in the generated code while the
  runtime returned `null`.
