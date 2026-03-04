---
"@stackables/bridge-compiler": patch
---

Fix three code generation bugs that caused `SyntaxError: await is only valid in async functions` when array mappings combined `catch` fallbacks or element-scoped tools with control flow.

- **Bug 1 – catch inside array `.map()`:** `needsAsync` only checked for element-scoped tool calls. Wires with `catch` fallbacks or `catch` control flow that fall back to an async IIFE now also trigger the async `for...of` loop path.

- **Bug 2 – element-scoped tool inside `.flatMap()`:** When a `?? continue` (or similar) control flow was detected first, the compiler unconditionally emitted `.flatMap()`. If the same loop also contained an element-scoped tool (`alias tool:iter`), the `await __call(...)` was placed inside a synchronous `.flatMap()` callback. `needsAsync` is now evaluated before the control-flow check, and when true, a `for...of` loop with a native `continue` statement is emitted instead.

- **Bug 3 – nested sub-array async blindspot:** The inner sub-array handler in `buildElementBody` never calculated `needsAsync`, always falling back to a synchronous `.map()`. It now uses the same async `for...of` IIFE pattern when inner wires contain element-scoped tools or catch expressions.
