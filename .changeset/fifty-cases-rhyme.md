---
"@stackables/bridge-compiler": minor
"@stackables/bridge-parser": minor
"@stackables/bridge-core": minor
---

Multi-Level Control Flow (break N, continue N)

When working with deeply nested arrays (e.g., mapping categories that contain lists of products), you may want an error deep inside the inner array to skip the outer array element.

You can append a number to break or continue to specify how many loop levels the signal should pierce.