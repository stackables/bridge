# Development Notes — The Bridge

> Internal notes for migration into `@stackables/bridge`. This repo will be archived.

---

## Project Identity

- **Name:** The Bridge
- **npm package:** `@stackables/bridge`
- **package.json name still says:** `bridge-engine` (was never updated — do it in the new repo)
- **Node:** v22+ (tested on v24.9.0)
- **Module system:** ESM (`"type": "module"`)
- **Test runner:** `node:test` + `tsx` — no Jest, no Vitest

---

## What It Does

Declarative dataflow engine for GraphQL. Instead of writing resolvers, you write `.bridge` files that describe *what data is needed and where it comes from*. The engine resolves backwards from demand — only fetches what the client actually asked for.

---

## Source Files

```
src/
  index.ts            — public API exports
  bridge-format.ts    — parser + serializer for .bridge text format
  bridge-transform.ts — GraphQL schema transformer (wraps resolvers)
  ExecutionTree.ts    — pull-based execution engine (core logic)
  types.ts            — all shared types (NodeRef, Wire, Bridge, ToolDef, etc.)
  tools/
    index.ts          — builtinTools bundle (std namespace + httpCall) + re-exports
    http-call.ts      — createHttpCall (REST API tool)
    upper-case.ts     — upperCase string tool
    lower-case.ts     — lowerCase string tool
    find-object.ts    — findObject array search tool
    pick-first.ts     — pickFirst array tool (optional strict mode)
    to-array.ts       — toArray wraps single value in array
```

### What was deleted (do not recreate as library code)
- `gateway.ts` — was a `createGateway()` test helper wrapping graphql-yoga. Lives in `test/_gateway.ts` now. Not part of the public API.
- `helpers.ts` — contained legacy `fakeProviderCall`. Deleted when backward compat was removed.

---

## Public API (src/index.ts)

```typescript
import { parseBridge } from "@stackables/bridge";
// parsesBridge(text: string): Instruction[]

import { bridgeTransform } from "@stackables/bridge";
// bridgeTransform(schema: GraphQLSchema, instructions: InstructionSource, options?: BridgeOptions): GraphQLSchema

import { builtinTools, std, createHttpCall, upperCase, lowerCase, findObject } from "@stackables/bridge";
// builtinTools — namespaced tool bundle: { std: { httpCall, upperCase, lowerCase, findObject, pickFirst, toArray } }
// std — the std namespace object (for spreading into overrides)
// createHttpCall(fetchFn?, cacheStore?): ToolCallFn
// upperCase, lowerCase, findObject — individual tool functions (for direct JS use)

// Types
import type { BridgeOptions, InstructionSource, Instruction, ToolCallFn, ToolDef, ConstDef, ToolMap } from "@stackables/bridge";
```

### `InstructionSource`
```typescript
type InstructionSource = Instruction[] | ((context: any) => Instruction[]);
```
Can be a static array or a **per-request function** for multi-provider routing. The function receives the full GraphQL context. Schema is built once — the function is called per request inside the resolver.

### `BridgeOptions`
```typescript
type BridgeOptions = {
  tools?: ToolMap;
  contextMapper?: (context: any) => Record<string, any>;
}
```
- `tools` — recursive tool map supporting namespaced nesting. The built-in `std` namespace (httpCall, upperCase, lowerCase, findObject, pickFirst, toArray) is always included; user-provided tools are shallow-merged on top. All `std` tools are callable with or without the `std.` prefix. To override a `std` tool, replace the `std` key: `tools: { std: { ...std, httpCall: createHttpCall(fetch, myCache) } }`.
- `contextMapper` — optional function to reshape/restrict the GraphQL context before it reaches bridge files. By default the full context is exposed.

### Context access
The engine passes the full GraphQL context to any tool or bridge that declares `with context`. This gives access to auth tokens, config, feature flags — anything on the context.

```typescript
// Server setup
context: () => ({
  hereapi: { apiKey: process.env.HEREAPI_KEY },
  auth: { userId: '...' },
})
```

To restrict what bridge files can see, use `contextMapper`:
```typescript
bridgeTransform(schema, instructions, {
  contextMapper: (ctx) => ({ hereapi: ctx.hereapi }),
})
```

---

## The .bridge Language

Every `.bridge` file must begin with a version declaration — the parser rejects anything without it:

```bridge
version 1.4
```

This must be the first non-blank, non-comment line. The current parser accepts only `1.4`; any other version string is a hard error.

### Reserved Words

**Keywords** — cannot be used as tool names, handle aliases, or const names:

> `bridge` `with` `as` `from` `const` `tool` `version` `define`

**Source identifiers** — reserved for their specific role in `bridge`/`tool` blocks:

> `input` `output` `context`

The parser throws immediately if any of these appear where a user-defined name is expected.

Three block types, multiple operators. **Braces are mandatory** for `bridge` and `tool` blocks that have a body. The opening `{` goes on the keyword line; the closing `}` goes on its own line at column 0. Body lines (with, wires, params) are indented 2 spaces. No-body tools like `tool first from std.pickFirst` omit braces. Blocks are self-delimiting — the `---` separator is accepted but no longer required.

### Block types
| Block | Purpose |
|---|---|
| `tool ... from` | Configures a function or inherits from a parent tool — URL, headers, params |
| `define` | Declares a reusable subgraph (pipeline) invocable from bridges |
| `bridge` | Connects a GraphQL field to tools |
| `const` | Declares named JSON constants reusable across tools and bridges |

`tool <name> from <source>` is the only syntax for tool definitions.

### `const` blocks
Declare named values as raw JSON. Multiple consts can exist in one file.

```bridge
const fallbackGeo = { "lat": 0, "lon": 0 }
const defaultCurrency = "EUR"
const maxRetries = 3
```

Consts are accessed via `with const as c` in tool or bridge blocks, then referenced as `c.<name>` or `c.<name>.<path>`. Multi-line JSON (objects and arrays) is supported — the parser tracks brace/bracket depth. Values are stored as raw JSON strings and parsed at runtime.

### Operators
| Operator | Meaning |
|---|---|
| `=` | Constant — sets a fixed value |
| `<-` | Wire — pulls data from a source at runtime |
| `<-!` | Forced wire — eagerly schedules the target tool even if no field demands its output. Used for side-effect-only tools (audit logging, analytics, cache warming). Error isolation: a forced tool failure does not break the main response. |
| `<- h1:h2:source` | Pipe chain — all handles must be declared with `with`; routes source → h2.in → h1.in; each handle's full return value feeds the next stage |
| `<-! h1:h2:source` | Forced pipe chain — same as pipe but eagerly scheduled. The force flag is placed on the outermost fork. |
| `\|\| <source>` | Null-coalesce next — inline alternative source (handle.path or pipe chain). Tried if the preceding source resolves to `null`/`undefined`. Multiple `\|\|` alternatives can be chained. |
| `\|\| <json>` | Null-fallback literal — last item in a `\|\|` chain. If all sources are null, returns this JSON value. Fires on _absent/null values_, not on errors. |
| `?? <json>` | Error-fallback literal — if the entire resolution chain **throws**, returns this parsed JSON. Fires on _errors_, not on null values. |
| `?? <source>` | Error-fallback source — if the entire resolution chain throws, pulls from this handle.path or pipe chain instead. Can be any valid source expression. |
| `on error = <json>` | Tool-level fallback — declared inside a tool block. If `fn(input)` throws, the tool returns the parsed JSON instead of propagating the error. Only catches tool execution errors, not wire resolution errors. |
| `on error <- <source>` | Tool-level fallback from source — same as above but pulls the fallback value from context or another tool dependency at runtime. |
| `o.field <- src[] as i { ... }` | Array mapping — iterates source array. The iterator `i` is declared with `as i`. `i.field` references the current element. `.field = "value"` inside the block sets an element constant. |

**Full COALESCE — `||` and `??` compose into Postgres-style COALESCE + error guard:**
```bridge
# o.label <- A || B || C || "literal" ?? errorSource
o.label <- api.label || backup.label || transform:api.code || "unknown" ?? up:i.errDefault

# Evaluation order:
# api.label non-null      → use it (fast, returned immediately)
# api.label null          → try backup.label
# backup.label null       → try transform(api.code)  (pipe chain)
# all null                → "unknown"  (|| json literal)
# all throw               → up(i.errDefault)  (?? pipe source)
```

`||` source alternatives desugar to multiple wires with the same target. The engine evaluates all in parallel and returns the first non-null value, so cheaper/faster sources naturally win without a cost model.

### Multi-wire priority (duplicate target)
Multiple wires pointing to the same target field express **source priority**: the engine evaluates all sources in parallel and returns the first that resolves to a non-null value. Cheaper/local sources (input args) resolve before slower remote tools, so priority is naturally ordered by speed.

```bridge
# Explicit multi-wire form (equivalent to || inline):
o.textPart <- i.textBody             # prefer user-supplied plain text (fast, already in args)
o.textPart <- convert:i.htmlBody     # derive from HTML if textBody is absent (needs tool call)

# Inline coalesce form (desugars to the same two wires + literal fallback):
o.textPart <- i.textBody || convert:i.htmlBody || "empty" ?? i.errorDefault
```

- If `i.textBody` is non-null → used immediately, `convert` never runs.
- If `i.textBody` is null → `convert(htmlBody)` result is used.
- If all sources are null → `||` literal fires.
- If all sources throw → `??` source/literal fires.

### `tool` blocks
Define a reusable API call configuration. Syntax: `tool <name> from <source>`. When `<source>` is a function name (e.g. `httpCall`), a new tool is created. When `<source>` is an existing tool name, the new tool inherits its configuration.

```bridge
tool hereapi from httpCall {
  with context
  .baseUrl = "https://geocode.search.hereapi.com/v1"
  .headers.apiKey <- context.hereapi.apiKey
}

tool hereapi.geocode from hereapi {
  .method = GET
  .path = /geocode
}
```

Param lines use a `.` prefix — the dot means "this tool's own field". `with` and `on error` lines are control flow and do not take a dot prefix.

When inheriting from a parent tool, the engine merges wires from the parent chain by:
1. Walking the inheritance chain from root to leaf
2. Merging wires (child overrides parent by `target` path; `onError` wires merge by kind — child wins)
3. Merging deps (deduplicated by handle name)

**`with context`** — declares a dep on the GraphQL context (auth tokens, API keys, feature flags, etc.).  
**`with <tool> as <handle>`** — declares a tool-to-tool dependency. The dep tool is called first and its result is available as `handle` in wires. Results are cached per request.  
**`on error = <json>`** — tool-level fallback. If `fn(input)` throws, this JSON value is returned instead. Only catches execution errors, not wire resolution.  
**`on error <- <source>`** — same but pulls fallback from context/tool at runtime. Example: `on error <- context.fallbacks.geo`.

### `define` blocks
Declare a reusable named subgraph (pipeline). Syntax: `define <name> { ... }`. The body uses the same wire syntax as bridge blocks, with `with input as i` and `with output as o` declaring the pipeline's interface.

```bridge
define geocode {
  with std.httpCall as geo
  with input as i
  with output as o

  geo.baseUrl = "https://nominatim.openstreetmap.org"
  geo.method = GET
  geo.path = /search
  geo.q <- i.city
  o.lat <- geo[0].lat
  o.lon <- geo[0].lon
}
```

Use in a bridge with `with <define> as <handle>`. The define's inputs are written via `<handle>.<input>` and outputs are read via `<handle>.<output>`:

```bridge
bridge Query.location {
  with geocode as g
  with input as i
  with output as o

  g.city <- i.city
  o.lat <- g.lat
  o.lon <- g.lon
}
```

Each invocation is fully isolated — calling the same define twice creates independent tool instances. Inlining happens at parse time; the executor treats the expanded wires identically to hand-written ones.

### `bridge` blocks
Connect a GraphQL field to its tools.

```bridge
bridge Query.geocode {
  with hereapi.geocode as gc
  with input as i
  with output as o

  gc.q <- i.search

  o.results <- gc.items[] as item {
    .name <- item.title
    .lat  <- item.position.lat
    .lon  <- item.position.lng
  }
}
```

**`with input as i`** — binds GraphQL field arguments.  
**`with output as o`** — declares the output handle. **Required in every `bridge` block.** All output field assignments must go through this handle: `o.<field> <- source`. Tool input wires (`<tool>.<param> <- ...`) do not use the output handle.  
**`with <tool> as <handle>`** — binds a tool call result. When the name matches a registered tool function directly (e.g. a built-in like `std.upperCase`), no separate `tool` block is required. A `tool` block is only needed when you want to configure defaults or inherit from a parent tool.  
**`with <define> as <handle>`** — invokes a define block. The define's inputs are written as `<handle>.<input>` and outputs read as `<handle>.<output>`.  
**`o.results <- gc.items[] as item { ... }`** — array mapping. Creates a shadow tree per element. The iterator `item` references the current element — `item.field` accesses element data. The `{ }` block can also include element constants (`.field = "value"`).

Example — pipe-like built-in tools need no `tool` block:
```bridge
bridge Query.format {
  with std.upperCase as up
  with std.lowerCase as lo
  with input as i
  with output as o

  o.upper <- up:i.text
  o.lower <- lo:i.text
}
```

Multiple bridge blocks can be in one `.bridge` file.

---

## Internal Architecture

### ExecutionTree

The core execution primitive. One is created per GraphQL root field call (Query/Mutation). It:
- Holds a `state` map (trunk key → result promise)
- Resolves wires backwards from demand (`response()` is called by the resolver for every field)
- Uses `Promise.any()` to resolve the first available source for a field with multiple wire candidates
- Caches tool dependency calls (`toolDepCache`) — a tool that is a dependency for multiple fields is only called once per request

**Trunk** — identifies a node in the graph:
```typescript
{ module: string, type: string, field: string, instance?: number }
```
`module` is the dotted tool name (e.g. `"hereapi"`, `"hereapi.geocode"`) or `SELF_MODULE = "_"` for the bridge's own input/output.

**Shadow trees** — when an array mapping is encountered (`o.results <- gc.items[] as item { ... }`), a shadow `ExecutionTree` is created per array element. Shadow trees delegate `schedule()` and `resolveToolDep()` to their parent, but have their own `state` for element-scoped data.

**Execution flow:**
1. GraphQL resolver calls `response(info.path, isArray)` on the ExecutionTree
2. At root entry (`!info.path.prev`), after `push(args)`, `executeForced()` is called — this finds all `force: true` wires and eagerly schedules their target trunks via `schedule()`, with `.catch(() => {})` to suppress unhandled rejections for fire-and-forget tools
3. `response()` finds matching wires for the current path
4. For each wire source, calls `pullSingle(ref)` which calls `schedule(target)` if not yet in state
5. `schedule()` resolves tool wires + bridge wires, builds the input object, calls the tool function
6. Result stored in state, downstream resolvers pick from it

### Multi-wire null-coalescing (was: `Promise.any()`)
Multiple wires targeting the same field are evaluated in parallel. The engine returns the **first non-null/non-undefined value**. This means:
- Cheap sources (input args) win over slow tool calls naturally — they're already in state.
- If all sources resolve to null → resolves `undefined` (allowing `||` to fire).
- If all sources throw → rejects with `AggregateError` (allowing `??` to fire).

Before this design, `Promise.any()` was used, which raced on fulfillment — meaning a `null` value from a fast source would win over a real value from a slower one. The current implementation skips null/undefined values and only settles once a real value is found or all options are exhausted.

---

## Design Decisions Made (and why)

### No backward compat / no `provider` keyword
The old API had a `provider` keyword and a `legacyProviderCall` option. All of this was removed. The `tool <name> from <source>` keyword is the canonical syntax for tool definitions.

### `gateway.ts` is not public API
`createGateway()` is a test helper. It wraps graphql-yoga + `bridgeTransform` for convenience in tests. It lives in `test/_gateway.ts`. The library itself has no dependency on graphql-yoga — users bring their own server.

### Full context, not namespaced
The engine passes the full GraphQL context to `with context` — no wrapping under `context.config` or `context.bridge`. Users control what’s on the context at the server level. To restrict access, pass a `contextMapper` function to `bridgeTransform()`.

### Function-based `InstructionSource` instead of `Record<string, Instruction[]>`
Multi-provider routing was first implemented with a `Record<string, Instruction[]>` map + `context.bridge.implementation` key. This was replaced with a function signature: `(context) => Instruction[]`. Rationale: the engine doesn't need to know how routing works — the user writes the lookup function and has full control. The Record pattern is still possible, just done by the user in their function.

### Three-layer fallback architecture
Fault tolerance is split into three independent layers that compose, innermost-first:

1. **Tool `on error`** — catches only `fn(input)` throws. Returns a constant JSON value or pulls one from context. Inherited through `tool ... from` chains (child overrides parent).
2. **Wire `||` null-guard** — catches null/undefined resolution. Fires when the source resolves successfully but the value is absent. Can be a JSON literal or a source reference (handle.path or pipe chain).
3. **Wire `??` error-guard** — catches any failure in the entire resolution chain (tool down, dep failure). Applied as a `.catch()` wrapping the resolved promise (including the `||` layer). Can be a JSON literal **or a source/pipe expression** — if a source, it is scheduled lazily and only executed when the catch fires.

Firing order when all three are present: `on error` → `||` → `??`. Each layer only fires if the one inside it did not produce a usable value.

| Scenario | Layer that fires |
|---|---|
| Tool fn throws, `on error` present | `on error` (tool scope) |
| Tool fn throws, no `on error` | `??` (wire scope) |
| Tool returns `{ label: null }` | `\|\|` |
| `??` is a source expression, all throw | `??` schedules and calls the source |
| Tool returns `{ label: "Berlin" }` | none — real value used |

### Const blocks store raw JSON strings
`ConstDef.value` stores the raw JSON string, not a parsed object. It’s parsed at runtime via `JSON.parse()`. This keeps the type simple and makes serializer roundtrip exact. The parser validates JSON at parse time and throws on invalid syntax.

### Namespaced tools and `std` is always bundled
`builtinTools` is a nested object: `{ std: { httpCall, upperCase, lowerCase, findObject, pickFirst, toArray } }`. The `std` namespace is always merged in — user tools are added alongside via shallow spread. In `.bridge` files, all built-in tools are callable with or without the `std.` prefix (e.g. both `httpCall` and `std.httpCall` work). The `lookupToolFn()` method in `ExecutionTree` splits on dots and traverses the nested map, falling back to `std.*` for unqualified names.

### httpCall caching
`createHttpCall(fetchFn?, cacheStore?)` accepts an optional `CacheStore` for response caching. When a tool sets `cache = <seconds>`, httpCall caches responses by `method + URL + body` with TTL eviction. Default store: in-memory `Map`. Users can pass Redis or any key-value store implementing `{ get(key): any, set(key, value, ttl): void }` — both sync and async are supported.

---

## Test Structure

```
test/
  bridge-format.test.ts   — parser/serializer unit tests (parseBridge, serializeBridge, parsePath)
  http-executor.test.ts   — createHttpCall unit tests + cache tests (mock fetch)
  executeGraph.test.ts    — integration: basic field wiring, array mapping
  chained.test.ts         — integration: tool-to-tool chaining
  email.test.ts           — integration: mutation + response header extraction
  property-search.test.ts — integration: reads from test/property-search.bridge file
  tool-features.test.ts   — integration: missing tool, inheritance chain, config pull, tool-to-tool deps
  scheduling.test.ts      — scheduling correctness: diamond dedup, pipe fork parallelism, wall-clock parallelism
  force-wire.test.ts      — forced wire (<-!): parser, serializer roundtrip, end-to-end forced execution
  resilience.test.ts      — const blocks, tool on error, wire ?? fallback: parser, serializer, end-to-end
  builtin-tools.test.ts   — built-in tools: unit tests, bundle shape, default/override behaviour, e2e with bridge, inline with syntax
  _gateway.ts             — test helper (not a test file, not picked up by test runner)
  property-search.bridge  — fixture .bridge file used by property-search.test.ts
```

Test runner command: `node --import tsx/esm --test test/*.test.ts`  
`_gateway.ts` starts with `_` so it does NOT match `test/*.test.ts` glob. That's intentional.

**224 tests, all passing.**

---

## Examples

```
examples/
  weather-api/      — weather API: chains geocoding + weather, no API keys needed
  builtin-tools/    — std namespace tools (upperCase, lowerCase, findObject) without external APIs
```

All examples use `.bridge` files.

---

## Dependencies

```json
"dependencies": {
  "@graphql-tools/utils": "^11.0.0",  // mapSchema, MapperKind
  "graphql": "^16.12.0"
},
"devDependencies": {
  "@graphql-tools/executor-http": "^3.1.0",  // test HTTP executor
  "graphql-yoga": "^5.18.0",                 // test helper + examples
  "tsx": "^4.21.0",                           // TS runner for tests + examples
  "typescript": "^5.9.3"
}
```

`graphql-yoga` is a **dev** dependency only. The engine is server-agnostic.

---

## Known Gaps / Future Work

- **No published package yet** — `package.json` still says `private: true`, name is `bridge-engine`. Change to `@stackables/bridge` in new repo.
- **No build step** — `main` points to `./src/index.ts`. For publishing, add a build config (tsc or tsup) that outputs `./dist/`.
- **No multi-provider routing test** — the function-based `InstructionSource` feature has no dedicated test. The path: create two parseBridge instruction sets, pass a selector function, verify the correct one is used based on context.
- **httpCall only handles flat `rest` fields as query/body params** — nested input objects in `rest` (e.g. `body.nested.thing`) go directly into the body as-is. No flattening. This is probably fine but worth documenting explicitly.
- **Array mapping requires the source to be an array** — if the wire source is not an array at runtime, `items.map(...)` will throw. No graceful handling.
- **No streaming / subscriptions** — engine is request/response only.
