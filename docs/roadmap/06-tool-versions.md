
## Unified Tool Versioning 

**Target Version:** 2.1

**Status:** Defined

**Core Goal:** Enable parallel execution of multiple tool versions and provide a deterministic way to resolve namespaces into versioned packages.


### 1. Language Syntax: The `@` Binding

The `with` statement is updated to support an optional version tag using the `@` symbol.

* **Syntax:** `with <identifier>[@version] [as <alias>]`
* **Default Behavior:**
  * the engine defaults to the **Language Version** specified in the `version` header for the `std` library
  * Sepcifies to the latest for all other tools
* **Explicit Versioning:** If a version is provided (e.g., `@2.x`), the engine uses that specific range for resolution.

```bridge
version 1.4

# 1. Standard Library resolution (uses v1.4.x based on file header)
with std.str.upper

# 2. Tool version
with myCorp.utils@2.1 as utils

# 3. Use older version of std library
with std.str.upper@0.8 as oldFetch

```

---

### 2. API Change: Version-Partitioned Registry

The tool registry provided to the engine moves from a flat object to a **Version-Aware Map**.

**Structure:**

```typescript
const registry = {
  // Key format: "package.path"
  "std": {
    "1.4.0": { str: { upper: ... } }
  },
  "myCorp.utils": {
    "1.0.0": { geocoder: ... },
    "2.1.0": { geocoder: ... } // Different logic
  },
  "myCorp": {
    "3.0.0": { utils: { geocoder: ... } },
  }
};

```

### 4. Semantic Versioning (SemVer) Support

The engine will not just perform exact string matches for versions.

* **Resolution:** The engine will resolve the **Highest Compatible Version** within the requested range.
* **Parallelism:** If two different bridge files request `stripe@1.x` and `stripe@2.x`, the engine resolves and maintains both versions in the registry simultaneously, routing calls based on the bridge's specific binding.

### 6. Implementation Impact

* **Parsing:** Low. The `@` is a simple delimiter in the `with` parser.
* **Execution:** Medium. Requires a cache for resolved bindings so the "Backwards Scan" only happens once per bridge initialization, not once per request.
* **Portability:** High. Bridges become completely self-contained, knowing exactly which tool contracts they require to run.
