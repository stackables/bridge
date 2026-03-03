# Security Policy

Security is a top priority for us, especially since The Bridge functions as an egress gateway handling sensitive context (like API keys) and routing HTTP traffic.

## Supported Versions

| Package                       | Version | Supported          | Notes                                                |
| ----------------------------- | ------- | ------------------ | ---------------------------------------------------- |
| `@stackables/bridge`          | 2.x.x   | :white_check_mark: | Umbrella package — recommended for most users        |
| `@stackables/bridge-core`     | 1.x.x   | :white_check_mark: | Execution engine                                     |
| `@stackables/bridge-parser`   | 1.x.x   | :white_check_mark: | Parser & language service                            |
| `@stackables/bridge-compiler` | 2.x.x   | :warning:          | AOT compiler — pre-stable, API may change            |
| `@stackables/bridge-stdlib`   | 1.x.x   | :white_check_mark: | Standard library tools (`httpCall`, strings, arrays) |
| `@stackables/bridge-graphql`  | 1.x.x   | :white_check_mark: | GraphQL schema adapter                               |
| `@stackables/bridge-types`    | 1.x.x   | :white_check_mark: | Shared type definitions                              |
| `bridge-syntax-highlight`     | 1.x.x   | :white_check_mark: | VS Code extension                                    |

Security patches are applied to the latest minor/patch of each supported major version.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues or discussions.**

If you discover a security vulnerability within The Bridge, please report it at https://github.com/stackables/bridge/security

Please include the following in your report:

- A description of the vulnerability and its impact.
- Steps to reproduce the issue (a minimal `.bridge` file and GraphQL query is highly appreciated).
- Any potential mitigation or fix you might suggest.

We will acknowledge receipt of your vulnerability report within 48 hours and strive to send you regular updates about our progress.

## Scope & Threat Model

For a comprehensive analysis of trust boundaries, attack surfaces, and mitigations across all packages, see our full [Security Threat Model](docs/threat-model.md).

Because The Bridge evaluates `.bridge` files and executes HTTP requests, we are particularly interested in reports concerning:

- **Credential Leakage:** Bugs that could cause secrets injected via `context` to be exposed in unauthorized logs, traces, or unmapped GraphQL responses.
- **Engine Escapes / RCE:** Vulnerabilities where a malicious `.bridge` file or dynamic input could break out of the engine sandbox and execute arbitrary code on the host. This includes the AOT compiler (`bridge-compiler`) which uses `new AsyncFunction()` for code generation.
- **SSRF (Server-Side Request Forgery):** Unexpected ways dynamic input could manipulate the `httpCall` tool to query internal network addresses not explicitly defined in the `.bridge` topology.
- **Prototype Pollution:** Bypasses of the `UNSAFE_KEYS` blocklist (`__proto__`, `constructor`, `prototype`) in `setNested`, `applyPath`, or `lookupToolFn`.
- **Cache Poisoning:** Cross-tenant data leakage through the `httpCall` response cache.
- **Playground Abuse:** Vulnerabilities in the browser-based playground or share API that could lead to data exfiltration or resource exhaustion.

**Out of Scope:**

- Hardcoding API keys directly into `.bridge` files or GraphQL schemas and committing them to version control. (This is a user configuration error, not an engine vulnerability.)
- Writing bridge files that send sensitive info from the context to a malicious server deliberately. (Writing insecure instructions is not a framework vulnerability.)
- GraphQL query depth / complexity attacks — these must be mitigated at the GraphQL server layer (Yoga/Apollo), not within The Bridge engine.
