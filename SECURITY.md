# Security Policy

Security is a top priority for us, especially since it functions as an egress gateway handling sensitive context (like API keys) and routing HTTP traffic.

## Supported Versions

Please note that The Bridge is currently in **Developer Preview (v1.x)**.

While we take security seriously and patch vulnerabilities as quickly as possible, v1.x is a public preview and is **not recommended for production use**. We will introduce strict security patch backporting starting with our stable v2.0.0 release.

| Version | Supported | Notes |
| --- | --- | --- |
| 1.x.x | :white_check_mark: | Active Developer Preview. Patches applied to latest minor/patch. |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues or discussions.**

If you discover a security vulnerability within The Bridge, please report it at https://github.com/stackables/bridge/security

Please include the following in your report:

* A description of the vulnerability and its impact.
* Steps to reproduce the issue (a minimal `.bridge` file and GraphQL query is highly appreciated).
* Any potential mitigation or fix you might suggest.

We will acknowledge receipt of your vulnerability report within 48 hours and strive to send you regular updates about our progress.

## Scope & Threat Model

Because The Bridge evaluates `.bridge` files and executes HTTP requests, we are particularly interested in reports concerning:

* **Credential Leakage:** Bugs that could cause secrets injected via `context` to be exposed in unauthorized logs, traces, or unmapped GraphQL responses.
* **Engine Escapes / RCE:** Vulnerabilities where a malicious `.bridge` file or dynamic input could break out of the engine sandbox and execute arbitrary code on the host.
* **SSRF (Server-Side Request Forgery):** Unexpected ways dynamic input could manipulate the `httpCall` tool to query internal network addresses not explicitly defined in the `.bridge` topology.

**Out of Scope:**

* Hardcoding API keys directly into `.bridge` files or GraphQL schemas and committing them to version control. (This is a user configuration error, not an engine vulnerability).
* Writing bridge files that send sensitive info from the context to malicious server deliberately (Writing insecure instructions is not a crime)
