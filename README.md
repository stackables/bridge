[![npm](https://img.shields.io/npm/v/@stackables/bridge?label=@stackables/bridge&logo=npm)](https://www.npmjs.com/package/@stackables/bridge)
[![extension](https://img.shields.io/badge/VS_Code-Full_Support-blue)](https://marketplace.visualstudio.com/items?itemName=stackables.bridge-syntax-highlight)


> **Developer Preview**
> The Bridge v1.x is a public preview.
> * Stability: The .bridge language and TypeScript API is largely stable.
> * Versioning: We follow strict SemVer starting from v2.0.0.
> 
> [See our roadmap](./docs/roadmap/) \
> [Feedback in the discussions](https://github.com/stackables/bridge/discussions/1)
>
> Feedback: We are actively looking for use cases. Please share yours in our GitHub Discussions.


# The Bridge

**Declarative dataflow for API integrations.**

Stop hardcoding third-party SDKs and API keys into every application. The Bridge is a hyper-lightweight execution engine that routes, reshapes, and secures traffic to external providers using static `.bridge` files.

Run it as a **GraphQL Egress Gateway** to give your internal teams a clean unified API, or use the **Standalone Runner** to execute declarative data pipelines directly in Node, Edge Workers, or the browser.

**Best fit when your architecture needs:**

* **Controlled Egress:** Funnel external API calls through a single point to enforce uniform rate-limiting, caching, and IP allowlisting.
* **Provider Agnosticism:** Swap external providers (SendGrid ↔ AWS SES) by changing a `.bridge` text file, without touching your calling services' code.
* **Centralized Secrets:** Inject external API keys at the gateway/execution level.
* **Messy REST abstraction:** Morph complex, undocumented REST payloads into clean, strongly-typed internal interfaces.

**Not best fit when you need:**

* Heavy domain modeling or multi-step database sagas.
* Imperative, line-by-line programming logic (The Bridge is a topology graph, not a script).

---

## The Playground

Try The Bridge instantly in your browser at **[bridge.sdk42.com](https://bridge.sdk42.com)**.

The playground is fully client-side. **Your API keys, schemas, and data are NEVER sent to our servers.** All parsing, routing, and HTTP execution happens directly inside your browser.

Want to run it offline or within your own VPN? You can spin up the playground locally by building the `./packages/playground` workspace directly from this repository.

![Playground Screenshot](./docs/images/screenshot-playground.png)

## Core Concepts: Wiring, not Programming

The Bridge is a **Data Topology Language**. You don't write scripts; you wire circuits.

* **Pull, Don't Push:** The engine is strictly lazy. If a client doesn't ask for a specific output field, the wires connected to it are "dead"—no code runs, and no external APIs are called.
* **Cost-Optimized Fallbacks:** The engine knows the difference between a cheap memory read and an expensive network call, automatically evaluating them in the optimal order.
* **LLM Friendly:** The language is visually distinct and heavily structural, making it incredibly easy for LLMs to generate correct API mappings from standard JSON schemas or OpenAPI specs.

**Don't think in scripts. Think in schematics.**

## Getting Started

The Bridge separates your mapping logic (`.bridge` files) from your execution environment. You define the logic once, and run it wherever you need.

### 1. Write the logic (`logic.bridge`)

```bridge
# VSCode extension
# https://marketplace.visualstudio.com/items?itemName=stackables.bridge-syntax-highlight

version 1.4

# 1. Configure an external tool
tool sendgrid from httpCall {
  with context
  .baseUrl = "https://api.sendgrid.com/v3"
  .path = "/mail/send"
  .method = POST
  .headers.Authorization <- context.SENDGRID_API_KEY
}

# 2. Wire inputs to the tool, and the tool to the output
bridge Mutation.sendEmail {
  with sendgrid as sg
  with input as i
  with output as o

  # Map our clean input to SendGrid's deeply nested JSON
  sg.personalizations[0].to[0].email <- i.to
  sg.from.email = "no-reply@yourdomain.com"
  sg.subject <- i.subject
  sg.content[0].type = "text/plain"
  sg.content[0].value <- i.textBody

  # Eagerly force the side-effect, throw if it fails
  force sg

  o.messageId <- sg.headers.x-message-id
  o.success = true
}

```

### 2. Choose your Runner

#### Option A: Standalone Mode (Edge / Serverless)

Execute `.bridge` files programmatically. Perfect for Cloudflare Workers, AWS Lambda, or embedding inside existing microservices.

```typescript
import { executeBridge, parseBridge } from "@stackables/bridge";
import { readFileSync } from "node:fs";

// 1. Parse the .bridge file
const instructions = parseBridge(readFileSync("logic.bridge", "utf-8"));

// 2. Execute the bridge with an input payload
const { data } = await executeBridge({
  instructions,
  operation: "Mutation.sendEmail",
  input: {
    to: "user@example.com",
    subject: "Hello!",
    textBody: "Welcome to our app.",
  },
  context: { SENDGRID_API_KEY: process.env.SENDGRID_KEY },
});

console.log(data.messageId);

```

#### Option B: GraphQL Gateway Mode

Automatically wrap The Bridge around a GraphQL schema to create an instant API Gateway.

```typescript
import { bridgeTransform, parseBridge } from "@stackables/bridge";
import { createSchema, createYoga } from "graphql-yoga";
import { readFileSync } from "node:fs";

const typeDefs = readFileSync("schema.graphql", "utf-8");
const instructions = parseBridge(readFileSync("logic.bridge", "utf-8"));

const schema = bridgeTransform(
  createSchema({ typeDefs }),
  instructions,
);

const yoga = createYoga({
  schema,
  context: () => ({ SENDGRID_API_KEY: process.env.SENDGRID_KEY }),
});

```

## Syntax Cheat Sheet

The `.bridge` language is designed to be scannable.

* `.` prefix means a property.
* `=` means static constant assignment.
* `<-` means dynamic data flow.

| Concept | Syntax Example | Description |
| --- | --- | --- |
| **Constants** | `.method = "POST"` | Sets a static configuration value. |
| **Wires** | `.body <- i.userData` | Pulls data from a source at runtime. |
| **Side Effects** | `force api ?? null` | Eagerly schedules a handle. Critical by default; `?? null` makes it fire-and-forget. |
| **Pipes** | `o.name <- uc:i.name` | Chains data through a tool right-to-left. |
| **Null Coalesce** | `o.name <- i.name \|\| "N/A"` | Alternative used if the current source resolves to `null`. |
| **Error Guard** | `o.price <- api.price ?? 0` | Alternative used if the current source **throws** an exception. |
| **Ternary** | `o.val <- i.isPro ? a : b` | Evaluates condition; strictly pulls only the chosen branch. |
| **Node Alias** | `alias uc:i.name as name` | Evaluates an expression once and caches it as a local graph node. |
| **Arrays** | `o <- items[] as it { }` | Iterates over an array, creating a local shadow scope for each element. |

👉 **[Read the Full Language Guide](./docs/bridge-language-guide.md)** for deep dives into `define` blocks, overdefinition optimization, and advanced fallbacks.

## Tools

To The Bridge engine, everything external is just a "Tool". A Tool is simply a JavaScript function that takes a JSON object as input, and returns a JSON object (or Promise) as output.

The Bridge ships with a standard library (`std`) that includes tools for HTTP requests, array manipulation, and basic string formatting.

You can inject your own custom tools into the engine in three lines of code:

```typescript
const myTools = {
  // A simple synchronous tool
  calculateTax: (input) => ({ total: input.price * 1.2 }),

  // An asynchronous database call
  fetchUser: async (input) => await db.users.findById(input.id),
};

// Standalone mode:
const { data } = await executeBridge({ instructions, operation, input, tools: myTools });

// Gateway mode:
const schema = bridgeTransform(createSchema({ typeDefs }), instructions, { tools: myTools });

```

👉 **[Read the Tools & Extensions Guide](./docs/tools.md)** to learn about the `std.httpCall` tool, response caching, and custom tool injection.

## Further Reading

| Document | Description |
| --- | --- |
| **[Language Guide](./docs/bridge-language-guide.md)** | Full syntax reference — tool blocks, define blocks, expressions, array mapping, and more. |
| **[Tools & Extensions](./docs/tools.md)** | Built-in tools, custom tools, `httpCall` configuration, and response caching. |
| **[Observability](./docs/observability.md)** | OpenTelemetry spans & metrics, structured logging, and `extensions.traces`. |
| **[Dynamic Routing](./docs/dynamic-routing.md)** | Per-request topology switching for multi-tenant, region-aware, and A/B deployments. |
| **[LLM Notes](./docs/llm-notes.md)** | Internal development notes and architecture reference. |
| **[Developer Guide](./docs/developer.md)** | Internals walkthrough for contributors — parser pipeline, execution engine, test setup. |