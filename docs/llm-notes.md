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
    index.ts          — builtinTools bundle + re-exports
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

import { builtinTools, createHttpCall, upperCase, lowerCase, findObject } from "@stackables/bridge";
// builtinTools — default tool bundle: { httpCall, upperCase, lowerCase, findObject, pickFirst, toArray }
// createHttpCall(fetchFn?): ToolCallFn
// upperCase, lowerCase, findObject — individual tool functions

// Types
import type { BridgeOptions, InstructionSource, Instruction, ToolCallFn, ToolDef, ConstDef } from "@stackables/bridge";
```

### `InstructionSource`
```typescript
type InstructionSource = Instruction[] | ((context: any) => Instruction[]);
```
Can be a static array or a **per-request function** for multi-provider routing. The function receives the full GraphQL context. Schema is built once — the function is called per request inside the resolver.

### `BridgeOptions`
```typescript
type BridgeOptions = {
  tools?: Record<string, ToolCallFn | ((...args: any[]) => any)>;
  contextMapper?: (context: any) => Record<string, any>;
}
```
- `tools` — tool functions by name. Defaults to `builtinTools` (httpCall, upperCase, lowerCase, findObject, pickFirst, toArray). Providing your own `tools` replaces the defaults entirely — spread `builtinTools` to keep them.
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

Three block types, multiple operators.

### Block types
| Block | Purpose |
|---|---|
| `tool` | Configures an API call — URL, headers, params |
| `bridge` | Connects a GraphQL field to tools |
| `const` | Declares named JSON constants reusable across tools and bridges |

### `const` blocks
Declare named values as raw JSON. Multiple consts can exist in one file.

```hcl
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
| `<- h1\|h2\|source` | Pipe chain — all handles must be declared with `with`; routes source → h2.in → h1.in; each handle's full return value feeds the next stage |
| `<-! h1\|h2\|source` | Forced pipe chain — same as pipe but eagerly scheduled. The force flag is placed on the outermost fork. |
| `?? <json>` | Wire fallback — appended to any `<-` wire. If the resolution chain fails (tool down, dep failure, missing data), the parsed JSON value is returned instead. Example: `lat <- api.lat ?? 0` |
| `on error = <json>` | Tool-level fallback — declared inside a tool block. If `fn(input)` throws, the tool returns the parsed JSON instead of propagating the error. Only catches tool execution errors, not wire resolution errors. |
| `on error <- <source>` | Tool-level fallback from source — same as above but pulls the fallback value from context or another tool dependency at runtime. |

### `tool` blocks
Define a reusable API call configuration. The first word after the tool name is the **function name** — looked up in the `tools` map at runtime.

```hcl
tool hereapi httpCall
  with context
  baseUrl = "https://geocode.search.hereapi.com/v1"
  headers.apiKey <- context.hereapi.apiKey

tool hereapi.geocode extends hereapi
  method = GET
  path = /geocode
```

**`extends`** merges wires from the parent chain. The engine builds the deepest child's input by:
1. Walking the `extends` chain from root to leaf
2. Merging wires (child overrides parent by `target` path; `onError` wires merge by kind — child wins)
3. Merging deps (deduplicated by handle name)

**`with context`** — declares a dep on the GraphQL context (auth tokens, API keys, feature flags, etc.).  
**`with <tool> as <handle>`** — declares a tool-to-tool dependency. The dep tool is called first and its result is available as `handle` in wires. Results are cached per request.  
**`on error = <json>`** — tool-level fallback. If `fn(input)` throws, this JSON value is returned instead. Only catches execution errors, not wire resolution.  
**`on error <- <source>`** — same but pulls fallback from context/tool at runtime. Example: `on error <- context.fallbacks.geo`.

### `bridge` blocks
Connect a GraphQL field to its tools.

```hcl
bridge Query.geocode
  with hereapi.geocode as gc
  with input as i

gc.q <- i.search

results[] <- gc.items[]
  .name <- .title
  .lat  <- .position.lat
  .lon  <- .position.lng
```

**`with input as i`** — binds GraphQL field arguments.  
**`with <tool> as <handle>`** — binds a tool call result. When the name matches a registered tool function directly (e.g. a built-in like `upperCase`), no separate `tool` block is required. A `tool` block is only needed when you want defaults or `extends`.  
**`results[] <- gc.items[]`** — array mapping. Creates a shadow tree per element. Nested wires starting with `.` are relative to the current element.

Example — pipe-like built-in tools need no `tool` block:
```hcl
bridge Query.format
  with upperCase as up
  with lowerCase as lo
  with input as i

upper <- up|i.text
lower <- lo|i.text
```

Multiple bridge blocks can be in one `.bridge` file, separated by `---`.

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

**Shadow trees** — when an array mapping is encountered (`results[] <- gc.items[]`), a shadow `ExecutionTree` is created per array element. Shadow trees delegate `schedule()` and `resolveToolDep()` to their parent, but have their own `state` for element-scoped data.

**Execution flow:**
1. GraphQL resolver calls `response(info.path, isArray)` on the ExecutionTree
2. At root entry (`!info.path.prev`), after `push(args)`, `executeForced()` is called — this finds all `force: true` wires and eagerly schedules their target trunks via `schedule()`, with `.catch(() => {})` to suppress unhandled rejections for fire-and-forget tools
3. `response()` finds matching wires for the current path
4. For each wire source, calls `pullSingle(ref)` which calls `schedule(target)` if not yet in state
5. `schedule()` resolves tool wires + bridge wires, builds the input object, calls the tool function
6. Result stored in state, downstream resolvers pick from it

### Why `Promise.any()`
Multiple wires can target the same field (e.g. two providers). The engine races them with `Promise.any()` and uses the first successful result. Failed/missing sources are silently ignored unless all fail.

---

## Design Decisions Made (and why)

### No backward compat / no `provider` keyword
The old API had a `provider` keyword and a `legacyProviderCall` option. All of this was removed. The `tool` keyword is the unified primitive.

### `gateway.ts` is not public API
`createGateway()` is a test helper. It wraps graphql-yoga + `bridgeTransform` for convenience in tests. It lives in `test/_gateway.ts`. The library itself has no dependency on graphql-yoga — users bring their own server.

### Full context, not namespaced
The engine passes the full GraphQL context to `with context` — no wrapping under `context.config` or `context.bridge`. Users control what’s on the context at the server level. To restrict access, pass a `contextMapper` function to `bridgeTransform()`.

### Function-based `InstructionSource` instead of `Record<string, Instruction[]>`
Multi-provider routing was first implemented with a `Record<string, Instruction[]>` map + `context.bridge.implementation` key. This was replaced with a function signature: `(context) => Instruction[]`. Rationale: the engine doesn't need to know how routing works — the user writes the lookup function and has full control. The Record pattern is still possible, just done by the user in their function.

### Two-layer fallback architecture
Fault tolerance is split into two independent layers that compose:

1. **Tool `on error`** — catches only `fn(input)` throws. Returns a constant JSON value or pulls one from context. Inherited through `extends` chains (child overrides parent).
2. **Wire `??` fallback** — catches any failure in the entire resolution chain (tool down, dep failure, missing field). Placed on the terminal wire. On pipe chains, the `??` sits on the output wire so it catches the full chain.

If both are present, `on error` fires first (tool scope). If the tool fallback itself fails or doesn’t apply, `??` catches the residual.

### Const blocks store raw JSON strings
`ConstDef.value` stores the raw JSON string, not a parsed object. It’s parsed at runtime via `JSON.parse()`. This keeps the type simple and makes serializer roundtrip exact. The parser validates JSON at parse time and throws on invalid syntax.

### `httpCall` is always registered as default
`builtinTools` is used as the default for `allTools` in `bridge-transform.ts`. If the user provides their own `tools` option, it replaces the defaults entirely. Users who need both built-ins and custom tools should spread `builtinTools` into their tools object.

---

## Test Structure

```
test/
  bridge-format.test.ts   — parser/serializer unit tests (parseBridge, serializeBridge, parsePath)
  http-executor.test.ts   — createHttpCall unit tests (mock fetch)
  executeGraph.test.ts    — integration: basic field wiring, array mapping
  chained.test.ts         — integration: tool-to-tool chaining
  email.test.ts           — integration: mutation + response header extraction
  property-search.test.ts — integration: reads from test/property-search.bridge file
  tool-features.test.ts   — integration: missing tool, extends chain, config pull, tool-to-tool deps
  scheduling.test.ts      — scheduling correctness: diamond dedup, pipe fork parallelism, wall-clock parallelism
  force-wire.test.ts      — forced wire (<-!): parser, serializer roundtrip, end-to-end forced execution
  resilience.test.ts      — const blocks, tool on error, wire ?? fallback: parser, serializer, end-to-end
  builtin-tools.test.ts   — built-in tools: unit tests, bundle shape, default/override behaviour, e2e with bridge, inline with syntax
  _gateway.ts             — test helper (not a test file, not picked up by test runner)
  property-search.bridge  — fixture .bridge file used by property-search.test.ts
```

Test runner command: `node --import tsx/esm --test test/*.test.ts`  
`_gateway.ts` starts with `_` so it does NOT match `test/*.test.ts` glob. That's intentional.

**169 tests, all passing.**

---

## Examples

```
examples/
  yoga-server/      — basic GraphQL Yoga server with hereapi geocoding
  email/            — mutation example with SendGrid
  apollo-federation/— Apollo Federation subgraph (uses ApolloServer, not Yoga)
```

All examples use `.bridge` files. The apollo-federation example shows how to set context in ApolloServer plugins (`requestDidStart` / `didResolveOperation`).

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
