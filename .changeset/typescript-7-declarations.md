---
"@stackables/bridge-stdlib": patch
---

The published type declarations are now emitted by TypeScript 7. In `tools/arrays.d.ts`, `tools/audit.d.ts` and `tools/strings.d.ts`, the `bridge` metadata of each tool is declared as `export { syncUtility as bridge }` inside the tool's namespace instead of `var bridge: { sync: true; trace: false }`. The type of `bridge` is the same, and the declarations still work with TypeScript 6. The JavaScript is unchanged.
