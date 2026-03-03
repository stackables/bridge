# Security Threat Model

> Last updated: March 2026

## 1. Trust Boundaries & Actors

The Bridge Framework spans multiple deployment contexts. We assume four primary actors:

1. **The External Client (Untrusted):** End-users sending HTTP/GraphQL requests to the running Bridge server.
2. **The Bridge Developer (Semi-Trusted):** Internal engineers writing `.bridge` files and configuring the Node.js deployment.
3. **Downstream APIs (Semi-Trusted):** The microservices or third-party APIs that Bridge calls via Tools.
4. **Playground Users (Untrusted):** Anonymous visitors executing Bridge code and sharing playground sessions via the browser-based playground.

_(Note: If your platform allows users to dynamically upload `.bridge` files via a SaaS interface, the "Bridge Developer" becomes "Untrusted", elevating all Internal Risks to Critical.)_

## 2. Package Inventory & Attack Surface Map

Each package has a distinct trust profile. Packages with no executable runtime code (pure types, static docs) are excluded from the threat analysis.

| Package                   | Risk Tier | Input Source                                   | Key Concern                                                    |
| ------------------------- | --------- | ---------------------------------------------- | -------------------------------------------------------------- |
| `bridge-parser`           | Medium    | `.bridge` text (developer/SaaS)                | Parser exploits, ReDoS, identifier injection                   |
| `bridge-compiler`         | **High**  | Parsed AST                                     | Dynamic code generation via `new AsyncFunction()`              |
| `bridge-core`             | **High**  | AST + tool map + client arguments              | Pull-based execution, resource exhaustion, prototype pollution |
| `bridge-stdlib`           | **High**  | Wired tool inputs (may originate from clients) | SSRF via `httpCall`, cache poisoning                           |
| `bridge-graphql`          | Medium    | GraphQL queries + schema                       | Context exposure, query depth                                  |
| `bridge-syntax-highlight` | Low       | Local `.bridge` files via IPC                  | Parser CPU exhaustion in VS Code                               |
| `playground`              | **High**  | Untrusted user input in browser + share API    | CSRF-like fetch abuse, share enumeration                       |
| `bridge-types`            | None      | —                                              | Pure type definitions, no runtime code                         |
| `docs-site`               | None      | —                                              | Static HTML/CSS/JS                                             |

---

## 3. External Attack Surface (Client ➡️ Bridge Server)

These are threats initiated by end-users interacting with the compiled GraphQL or REST endpoints.

### A. SSRF (Server-Side Request Forgery)

- **The Threat:** An external client manipulates input variables to force the Bridge server to make HTTP requests to internal, non-public IP addresses (e.g., AWS metadata endpoint `169.254.169.254` or internal admin panels).
- **Attack Vector:** A `.bridge` file wires user input directly into a tool's URL: `tool callApi { .baseUrl <- input.targetUrl }`. The `httpCall` implementation constructs URLs via plain string concatenation (`new URL(baseUrl + path)`), permitting path traversal (e.g., `path = "/../admin"`) with no allowlist or blocklist for private IP ranges.
- **Mitigation (Framework Level):** The `std.httpCall` tool should strictly validate or sanitize `baseUrl` inputs if they are dynamically wired. Developers should never wire raw client input to URL paths. All headers from the `headers` input are forwarded verbatim to the upstream — if user-controlled input is wired to `headers`, arbitrary HTTP headers can be injected.
- **Mitigation (Infrastructure Level):** Run the Bridge container in an isolated network segment (egress filtering) that blocks access to internal metadata IP addresses.

### B. Cross-Tenant Cache Leakage (Information Disclosure)

- **The Threat:** User A receives User B's private data due to aggressive caching.
- **Attack Vector:** The built-in `createHttpCall` caches upstream responses. The cache key is constructed as `method + " " + url + body` (**headers are not included in the cache key**). If two users with different `Authorization` headers make the same GET request, User B will receive User A's cached response.
- **Current Status:** The cache key does **not** incorporate `Authorization` or tenant-specific headers. Caching is only safe for public/unauthenticated endpoints. To disable caching, set `cache = "0"` on the tool.
- **Recommendation:** Include sorted security-relevant headers (at minimum `Authorization`) in the cache key, or clearly document that caching must be disabled for authenticated endpoints.

### C. GraphQL Query Depth / Resource Exhaustion (DoS)

- **The Threat:** A client sends a heavily nested GraphQL query, forcing the engine to allocate massive arrays and deeply resolve thousands of tools.
- **Attack Vector:** `query { users { friends { friends { friends { id } } } } }`
- **Mitigation:** The `@stackables/bridge-graphql` adapter relies on the underlying GraphQL server (Yoga/Apollo). Adopters **must** configure Query Depth Limiting and Query Complexity rules at the GraphQL adapter layer before requests ever reach the Bridge engine. The engine itself enforces `MAX_EXECUTION_DEPTH = 30` for shadow-tree nesting as a secondary guard.

### D. Error Information Leakage

- **The Threat:** Internal system details (stack traces, connection strings, file paths) leak to external clients via GraphQL error responses.
- **Attack Vector:** Tools that throw errors containing internal details propagate through the engine and appear in the `errors[]` array of the GraphQL response. When tracing is set to `"full"` mode, complete tool inputs and outputs are exposed via the `extensions.traces` response field — including potentially sensitive upstream data.
- **Mitigation:** Adopters should configure error masking in their GraphQL server (e.g., Yoga's `maskedErrors`). Tracing should never be set to `"full"` in production environments exposed to untrusted clients.

---

## 4. Internal Attack Surface (Schema ➡️ Execution Engine)

These are threats derived from the `.bridge` files themselves. Even if written by trusted internal developers, malicious or malformed schemas can exploit the Node.js runtime.

### A. Code Injection via AOT Compiler (RCE)

- **The Threat:** A malformed `.bridge` file or programmatically constructed AST injects raw JavaScript into the `@stackables/bridge-compiler` code generator.
- **Attack Vector:** The AOT compiler (`bridge-compiler`) generates a JavaScript function body as a string and evaluates it via `new AsyncFunction()`. A developer names a tool or field with malicious string terminators: `field "\"); process.exit(1); //"`.
- **Mitigation (multi-layered):**
  1. **Identifier validation:** The Chevrotain lexer restricts identifiers to `/[a-zA-Z_][\w-]*/` — only alphanumeric characters, underscores, and hyphens.
  2. **Synthetic variable names:** The codegen generates internal variable names (`_t1`, `_d1`, `_a1`) — user-provided identifiers are never used directly as JS variable names.
  3. **JSON.stringify for all dynamic values:** Tool names use `tools[${JSON.stringify(toolName)}]`, property paths use bracket notation with `JSON.stringify`, and object keys use `JSON.stringify(key)`.
  4. **Constant coercion:** `emitCoerced()` produces only primitives or `JSON.stringify`-escaped values — no raw string interpolation.
  5. **Reserved keyword guard:** `assertNotReserved()` blocks `bridge`, `with`, `as`, `from`, `throw`, `panic`, etc. as identifiers.
- **Residual Risk:** If consumers construct `BridgeDocument` objects programmatically (bypassing the parser), they bypass identifier validation. The `JSON.stringify`-based codegen provides defense-in-depth but edge cases in `emitCoerced()` for non-string primitive values should be reviewed.
- **CSP Note:** `new AsyncFunction()` is equivalent to `eval()` from a Content Security Policy perspective. Environments with strict CSP (`script-src 'self'`) will block AOT execution.

### B. Prototype Pollution via Object Mapping

- **The Threat:** The Bridge language constructs deep objects based on paths defined in the schema.
- **Attack Vector:** A wire is defined as `o.__proto__.isAdmin <- true` or `o.constructor.prototype.isAdmin <- true`. Both the interpreter (`setNested`) and the compiler (nested object literals) will attempt to construct this path.
- **Mitigation:** The `UNSAFE_KEYS` blocklist (`__proto__`, `constructor`, `prototype`) is enforced at three points:
  1. `setNested()` in `tree-utils.ts` — blocks unsafe assignment keys during tool input assembly.
  2. `applyPath()` in `ExecutionTree.ts` — blocks unsafe property traversal on source refs.
  3. `lookupToolFn()` in `toolLookup.ts` — blocks unsafe keys in dotted tool name resolution.
- **Test Coverage:** `prototype-pollution.test.ts` explicitly validates all three enforcement points.

### C. Circular Dependency Deadlocks (DoS)

- **The Threat:** The engine enters an infinite loop trying to resolve tools.
- **Attack Vector:** Tool A depends on Tool B, which depends on Tool A.
- **Mitigation:**
  - _Compiler:_ Kahn's Algorithm in `@stackables/bridge-compiler` topological sort mathematically guarantees that circular dependencies throw a compile-time error.
  - _Interpreter:_ The `pullSingle` recursive loop maintains a `pullChain` Set. If a tool key is already in the set during traversal, it throws a `BridgePanicError`, preventing stack overflows.

### D. Resource Exhaustion (DoS)

- **The Threat:** A bridge file with many independent tool calls or deeply nested structures exhausts server memory or CPU.
- **Attack Vector:** A `.bridge` file declares hundreds of independent tools, or deep array-mapping creates unbounded shadow trees.
- **Mitigation (implemented):**
  - `MAX_EXECUTION_DEPTH = 30` — limits shadow-tree nesting depth.
  - `toolTimeoutMs = 15_000` — `raceTimeout()` wraps every tool call with a deadline, throwing `BridgeTimeoutError` on expiry.
  - `AbortSignal` propagation — external abort signals are checked before tool calls, during wire resolution, and during shadow array creation. `BridgeAbortError` bypasses all error boundaries.
  - `constantCache` hard cap — clears at 10,000 entries to prevent unbounded growth.
  - `boundedClone()` — truncates arrays (100 items), strings (1,024 chars), and depth (5 levels) in trace data.
- **Gaps:** There is no limit on the total number of tool calls per request, no per-request memory budget, and no rate limiting on tool invocations. A bridge with many independent tools will execute all of them without throttling.

### E. `onError` and `const` Value Parsing

- **The Threat:** `JSON.parse()` is called on developer-provided values from the AST in `onError` wire handling and `const` block definitions.
- **Attack Vector:** Programmatically constructed ASTs (bypassing the parser) could supply arbitrarily large or malformed JSON, causing CPU/memory exhaustion during parsing.
- **Mitigation:** In normal usage, these values originate from the parser which validates string literals. The impact is limited to data within the execution context (no code execution). Adopters accepting user-supplied ASTs should validate `onError` and `const` values before passing them to the engine.

---

## 5. Playground Attack Surface

The browser-based playground (`packages/playground`) has a unique threat profile because it executes untrusted Bridge code client-side and provides a public share API.

### A. CSRF-like Fetch Abuse via Shared Links

- **The Threat:** An attacker crafts a playground share that, when opened by a victim, makes authenticated HTTP requests to internal APIs using the victim's browser cookies.
- **Attack Vector:** A crafted `.bridge` file using `httpCall` with a `baseUrl` pointing to a victim's internal service. The playground uses `globalThis.fetch` for HTTP calls — the browser will attach cookies for the target domain. The attacker shares the playground link; the victim opens it, and the bridge auto-executes.
- **Mitigation:** The browser's CORS policy prevents reading responses from cross-origin requests (the attacker cannot exfiltrate data). However, side-effect requests (POST/PUT/DELETE) may still succeed if the target API does not enforce CSRF tokens. Adopters of internal APIs should implement CSRF protection and `SameSite` cookie attributes.

### B. Share Enumeration (Information Disclosure)

- **The Threat:** Anyone who knows or guesses a 12-character share ID can read the share data. There is no authentication or access control.
- **Attack Vector:** Share IDs are 12-char alphanumeric strings derived from UUIDs. While brute-force enumeration is impractical (36¹² ≈ 4.7 × 10¹⁸ possibilities), share URLs may be leaked via browser history, referrer headers, or shared chat logs.
- **Mitigation:** Shares expire after 90 days. Share IDs have sufficient entropy to resist brute-force. Adopters should be aware that share URLs are effectively "anyone with the link" access — do not share playground links containing sensitive data (API keys, credentials, internal URLs).

### C. Share API Abuse (Resource Exhaustion)

- **The Threat:** An attacker floods the share API to exhaust Cloudflare KV storage.
- **Attack Vector:** Repeated `POST /api/share` requests with 128 KiB payloads.
- **Mitigation:** Payload size is capped at 128 KiB. Shares have 90-day TTL (auto-expiry). Cloudflare KV has built-in storage limits. There is no rate limiting — Cloudflare Workers rate limiting or a WAF rule should be applied in production.

---

## 6. IDE Extension Attack Surface

The VS Code extension (`packages/bridge-syntax-highlight`) provides syntax highlighting, diagnostics, hover info, and autocomplete for `.bridge` files via LSP.

- **Transport:** IPC (inter-process communication) between the extension host and language server — no network exposure.
- **Document scope:** Limited to `{ scheme: "file", language: "bridge" }` — only local `.bridge` files.
- **No code execution:** The language server only parses and validates — it never executes bridge files or tools.
- **Risk:** A maliciously crafted `.bridge` file in a workspace could trigger high CPU usage during parsing (Chevrotain's lexer uses simple regexes without backtracking, making ReDoS unlikely). The language server runs with VS Code's privilege level.

---

## 7. Operational & Downstream Risks

### A. Telemetry Data Leakage

- **The Threat:** Sensitive downstream data (PII, passwords, API keys) is logged to Datadog/NewRelic via OpenTelemetry spans.
- **Attack Vector:** The `@stackables/bridge-core` engine automatically traces tool inputs and outputs. If an HTTP tool returns a payload containing raw credit card data, the span attributes might log it in plain text.
- **Mitigation (implemented):** `boundedClone()` truncates traced data (arrays to 100 items, strings to 1,024 chars, depth to 5 levels) before storing in trace spans, reducing the blast radius.
- **Mitigation (not yet implemented):** A `redact` hook or `sensitive: true` field flag that prevents specific fields from being serialized into telemetry spans. Adopters should configure OpenTelemetry exporters to filter spans in the meantime.

### B. Unhandled Microtask Rejections

- **The Threat:** An upstream API fails synchronously, crashing the Node.js process.
- **Attack Vector:** A custom tool written by an adopter throws a synchronous `new Error()` instead of returning a rejected Promise.
- **Mitigation:** The execution engine wraps all tool invocations in exception handlers, coercing errors into Bridge-managed failure states (`BridgePanicError` and `BridgeAbortError` are treated as fatal via `isFatalError()`; all other errors enter the fallback/catch chain). The server remains available.

### C. Context Exposure via GraphQL Adapter

- **The Threat:** Sensitive data in the GraphQL context (auth tokens, database connections, session objects) is exposed to all bridge files.
- **Attack Vector:** When `bridgeTransform()` is used without a `contextMapper`, the full GraphQL context is passed to every bridge execution. Any bridge file can read any context property.
- **Mitigation:** Configure `options.contextMapper` to restrict which context fields are available to bridges. This is especially important in multi-tenant deployments where bridge files may be authored by different teams.

### D. Tool Dependency Cache Sharing

- **The Threat:** Mutable state returned by tools is shared across shadow trees within the same request.
- **Attack Vector:** `resolveToolDep()` delegates to the root tree's cache. If a tool returns a mutable object, shadow trees (e.g., array mapping iterations) may observe each other's mutations, causing nondeterministic behavior.
- **Mitigation:** Tool functions should return immutable data or fresh objects. The framework does not currently enforce immutability on tool return values.

---

## 8. Supply Chain

| Package                   | External Dependency                                      | Risk                                                                           |
| ------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `bridge-parser`           | `chevrotain@^11`                                         | Low — mature, deterministic parser framework with no `eval`                    |
| `bridge-stdlib`           | `lru-cache@^11`                                          | Low — widely used, actively maintained in-memory cache                         |
| `bridge-core`             | `@opentelemetry/api@^1.9`                                | Low — CNCF project, passive by default (no-op without SDK)                     |
| `bridge-graphql`          | `graphql@^16`, `@graphql-tools/utils@^11` (peer)         | Low — reference implementation                                                 |
| `playground`              | React 19, CodeMirror 6, Radix UI, Cloudflare Workers SDK | Medium — large dependency surface area, partially mitigated by browser sandbox |
| `bridge-syntax-highlight` | `vscode-languageclient`, `vscode-languageserver`         | Low — standard LSP libraries, IPC transport                                    |

---

## 9. Security Checklist for Adopters

1. **Never wire raw client input to `httpCall.baseUrl` or `httpCall.headers`** — use static baseUrl values in bridge files.
2. **Disable caching for authenticated endpoints** — set `cache = "0"` on any `httpCall` that includes `Authorization` headers until the cache key incorporates security-relevant headers.
3. **Configure `contextMapper`** in `bridgeTransform()` to restrict which GraphQL context fields are available to bridges.
4. **Enable query depth/complexity limiting** in your GraphQL server (Yoga/Apollo) before requests reach Bridge.
5. **Mask errors in production** — configure your GraphQL server to strip internal error details from client responses.
6. **Never use `"full"` tracing in production** — trace data may contain sensitive upstream payloads.
7. **Apply egress filtering** on the Bridge container to block access to internal metadata endpoints and private IP ranges.
8. **Review custom tools** for synchronous throws, mutable return values, and credential leakage in error messages.
9. **Do not share playground links containing sensitive data** — share URLs are effectively "anyone with the link" access.
