---
"@stackables/bridge-stdlib": minor
"@stackables/bridge": minor
---

Remove `std.assert` from the standard library. The tool is redundant with the `|| throw` and `?? throw` language syntax, which provides more expressive inline validation. Use `value <- source || throw "message"` instead.
