---
"@stackables/bridge": patch
"@stackables/bridge-core": patch
"@stackables/bridge-compiler": patch
"@stackables/bridge-parser": patch
---

Fix strict nested scope resolution for array mappings.

Nested scopes can now read iterator aliases from visible parent scopes while
still resolving overlapping names to the nearest inner scope. This also keeps
invalid nested tool input wiring rejected during parsing.
