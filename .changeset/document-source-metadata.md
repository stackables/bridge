---
"@stackables/bridge": patch
"@stackables/bridge-core": patch
"@stackables/bridge-compiler": patch
"@stackables/bridge-graphql": patch
"@stackables/bridge-parser": patch
---

Move Bridge source metadata onto BridgeDocument.

Parsed documents now retain their original source text automatically, and can
optionally carry a filename from parse time. Runtime execution, compiler
fallbacks, GraphQL execution, and playground formatting now read that metadata
from the document instead of requiring callers to thread source and filename
through execute options.
