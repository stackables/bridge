---
"@stackables/bridge": patch
"@stackables/bridge-core": patch
---

Improve formatted runtime errors for missing tools and source underlines.

`No tool found for "..."` and missing registered tool-function errors now carry
Bridge source locations when they originate from authored bridge wires, so
formatted errors include the filename, line, and highlighted source span.
Caret underlines now render the full inclusive source span instead of stopping
one character short.
