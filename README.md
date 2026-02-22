[![npm](https://img.shields.io/npm/v/@stackables/bridge?label=@stackables/bridge&logo=npm)](https://www.npmjs.com/package/@stackables/bridge)
[![extension](https://img.shields.io/badge/VS_Code-LSP-blue)](https://marketplace.visualstudio.com/items?itemName=stackables.bridge-syntax-highlight)
[![roadmap](https://img.shields.io/badge/Roadmap-green)](./docs/roadmap.md)
# The Bridge

**Declarative dataflow for controlled egress.**

Stop hardcoding third-party SDKs and API keys into every microservice. The Bridge allows you to build a unified internal gateway that routes, reshapes, and secures traffic to external providers using static `.bridge` files.

We use GraphQL strictly as a clean, strongly-typed interface for internal services. The Bridge is the engine that actually wires that interface to the outside world.

**Best fit when your architecture needs:**

* **Controlled Egress:** Funnel all external API calls through a single gateway to enforce uniform rate-limiting, caching, and a single Egress IP for vendor allowlisting.
* **Provider Agnosticism:** Swap external providers (SendGrid ↔ AWS SES, Stripe ↔ Braintree) without touching a single line of your calling services' code.
* **Centralized Secrets:** Inject external API keys at the gateway level instead of distributing them across your internal microservices.
* **Unified Internal API:** Give your internal teams a clean, single-endpoint graph to interact with messy external REST APIs.

**Not best fit when you need:**

* Heavy business logic or domain modeling.
* Multi-step database transactions or sagas.
* Very high-performance per-field computation.

> **Developer Preview**
> The Bridge v1.x is a public preview and is not recommended for production use.
> * Stability: Breaking changes to the .bridge language and TypeScript API will occur frequently.
> * Versioning: We follow strict SemVer starting from v2.0.0.
> 
> 
> Feedback: We are actively looking for use cases. Please share yours in our GitHub Discussions.

---

## The Architecture

If internal Service A and Service B both need to send an email, the standard approach is to install the SendGrid SDK and inject the API key into both services. This creates tight coupling.

Instead, you stand up a lightweight Egress Gateway powered by The Bridge. Service A and B simply make a standard GraphQL request to the gateway. The gateway uses your `.bridge` files to map the request, inject the credentials, and route the traffic. To your internal services, the external provider is completely invisible.

### What it is (and isn't)

The Bridge is a **Smart Mapping Outgoing Proxy**, not a replacement for your application logic.

* **Use it to:** Morph external API shapes, enforce single exit points for security, and manage vendor integrations independently of your core services.
* **Don't use it for:** Complex business logic. Keep the "intelligence" in your microservices; keep the "connectivity" in your Bridge.

### Wiring, not Programming

The Bridge is not a programming language. It is a Data Topology Language.

Unlike JavaScript or Python, where you write sequential instructions, a `.bridge` file describes a static circuit. There is no "execution pointer".

* **No Sequential Logic:** Shuffling the lines inside a block changes nothing. The engine uses your file to understand how internal fields physically wire to external tools.
* **Pull, Don't Push:** Your microservices "pull" data through the wires. If a client doesn't ask for a field, the wire is "dead"—no code runs, and no API is called.
* **Declarative Connections:** When you write `o.name <- api.name`, you aren't commanding a copy operation; you are soldering a permanent link between your internal interface and an external response.

**Don't think in scripts. Think in schematics.**

---

## The Workflow

You define your internal interface in standard GraphQL SDL, then use `.bridge` files to wire those types to your external providers.

### 1. Define your Schema

Start with `schema.graphql`. This is the clean interface your internal microservices will call.

```graphql
type EmailResult {
  success: Boolean
  messageId: String
}

type Mutation {
  sendEmail(to: String!, subject: String!, textBody: String!): EmailResult
}

```

### 2. Wire the Bridge

Create your `logic.bridge` file to map the schema to an external provider (e.g., SendGrid). This is your routing implementation.

```bridge
version 1.4

tool sendgrid from httpCall {
  .baseUrl = "https://api.sendgrid.com/v3"
  .path = "/mail/send"
  .method = POST
  
  with context as ctx
  .headers.Authorization = ctx.env.SENDGRID_API_KEY
}

bridge Mutation.sendEmail {
  with sendgrid as sg
  with input as i
  with output as o

  # Map our clean input to SendGrid's specific JSON structure
  sg.personalizations[0].to[0].email <- i.to
  sg.subject <- i.subject
  sg.content[0].type = "text/plain"
  sg.content[0].value <- i.textBody

  # Force execution (<-!) since this is a side-effect/mutation
  # and map the response back to our internal schema
  o.success <-! sg:true ?? false
  o.messageId <- sg.headers.x-message-id
}

```

### 3. Initialize the Engine

The Bridge engine takes your schema, attaches the routing logic, and exposes the gateway.

```typescript
import { bridgeTransform, parseBridge } from "@stackables/bridge";
import { createSchema, createYoga } from "graphql-yoga";

const typeDefs = /* load schema.graphql */;
const bridgeFile = /* load logic.bridge */;

const schema = bridgeTransform(
  createSchema({ typeDefs }), 
  parseBridge(bridgeFile)
);

const yoga = createYoga({
  schema,
  context: () => ({
    env: { SENDGRID_API_KEY: process.env.SENDGRID_API_KEY },
  }),
});

```

If you ever need to switch from SendGrid to AWS SES, you only rewrite `logic.bridge`. Your internal services and your GraphQL schema remain completely untouched.

---

## The Language

Get syntax highlighting for [Visual Studio Code](https://marketplace.visualstudio.com/items?itemName=stackables.bridge-syntax-highlight).

[Full language guide](https://www.google.com/search?q=./docs/bridge-language-guide.md)

Every `.bridge` file must begin with a version declaration (`version 1.4`). This is the first non-blank, non-comment line.

### 1. Const Blocks (`const`)

Named JSON values reusable across tools and bridges. Avoids repetition for fallback payloads, defaults, and config fragments. Access them via `with const as c`.

```bridge
const defaultCurrency = "EUR"
const maxRetries = 3

```

### 2. Tool Blocks (`tool ... from`)

Defines the "Where" and the "How." Takes a function (or parent tool) and configures it.

```bridge
tool <name> from <source> {
  [with context]                  # Injects GraphQL context (auth, secrets)
  [on error = <json_fallback>]    # Fallback value if tool fails

  .<param> = <value>              # Constant/Default value 
  .<param> <- <source>            # Dynamic wire
}

```

### 3. Define Blocks (`define`)

Reusable named subgraphs. Compose tools and wires into a pipeline, then invoke it from any bridge.

```bridge
define geocode {
  with std.httpCall as geo
  with input as i
  with output as o

  geo.baseUrl = "https://nominatim.openstreetmap.org"
  geo.q <- i.city
  o.lat <- geo[0].lat
  o.lon <- geo[0].lon
}

```

### 4. Bridge Blocks (`bridge`)

The routing logic connecting your internal schema fields to your tools.

```bridge
bridge <Type.field> {
  with <tool> [as <alias>]
  with input as i
  with output as o

  o.<field> = <json>                    # Constant output
  o.<field> <- <source>                 # Standard Pull (lazy)
  o.<field> <-! <source>                # Forced Push (eager/side-effect)
  o.<field> <- handle:source            # Route source through tool handle
  o.<field> <- <source> || <alt>        # Null-coalesce
  o.<field> <- <source> ?? <fallback>   # Error-fallback
}

```

---

## Key Features

### Scope Rules

Bridge uses explicit scoping. Any entity referenced inside a block must first be introduced using a `with` clause. `input` and `output` handles represent GraphQL execution and exist **only inside `bridge` blocks**.

### Resiliency (The COALESCE Chain)

Each layer handles a different failure mode, composing into a reliable fallback chain.

* **Layer 1: `on error` (Execution errors)**
Declared inside the `tool` block. Catches exceptions thrown by the tool itself.
* **Layer 2: `||` (Null / absent values)**
Fires when a source resolves successfully but returns `null` or `undefined`. Chains left-to-right.
* **Layer 3: `??` (Exceptions in the wire)**
Fires when the entire resolution chain throws (e.g., network failure).

```bridge
# o.label <- A || B || C || "literal" ?? errorSource
o.label <- api.label || tool:api.backup.label || "unknown" ?? tool:const.errorString

```

### Forced Wires (`<-!`)

By default, the engine is **lazy**. Use `<-!` to force execution regardless of downstream demand—mandatory for mutations, analytics, or cache warming.

```bridge
bridge Mutation.updateUser {
  with audit.logger as log
  with input as in
  with output as out

  # 'log' runs even if the client doesn't query the 'status' field
  out.status <-! log:in.changeData
}

```

### The Pipe Operator (`:`)

Routes data right-to-left through one or more tool handles.

```bridge
with output as o
# i.rawData → normalize → transform → result
o.result <- transform:normalize:i.rawData

```

---

## Syntax Reference

| Operator | Type | Behavior |
| --- | --- | --- |
| **`=`** | Constant | Sets a static value. |
| **`<-`** | Wire | Pulls data from a source at runtime. |
| **`<-!`** | Force | Eagerly schedules a tool (for side-effects). |
| **`:`** | Pipe | Chains data through tools right-to-left. |
| **`||`** | Null-coalesce | Next alternative if current source is `null`/`undefined`. Fires on absent values, not errors. |
| **`??`** | Error-fallback | Alternative used when the resolution chain **throws**. Fires on errors, not null values. |
| **`on error`** | Tool Fallback | Returns a default if the tool's execution throws. |
| **`<- src[] as i { }`** | Map | Iterates over array; element accessed via iterator `i`. |

---

## Built-in Tools

The Bridge ships with built-in tools under the `std` namespace (e.g., `std.httpCall`, `std.upperCase`).

| Tool | Input | Output | Description |
| --- | --- | --- | --- |
| `httpCall` | `{ baseUrl, method?, path?, headers?, cache?, ...fields }` | JSON | REST API caller. GET fields → query params; POST/PUT → JSON body. |
| `upperCase` | `{ in: string }` | `string` | Converts string to UPPER CASE. |
| `lowerCase` | `{ in: string }` | `string` | Converts string to lower case. |
| `findObject` | `{ in: any[], ...criteria }` | `object | undefined` | Finds first object in array matching criteria. |
| `pickFirst` | `{ in: any[], strict?: bool }` | `any` | Returns first array element. |
| `toArray` | `{ in: any }` | `any[]` | Wraps single value in an array. |

### Response Caching

Add `cache = <seconds>` to any `httpCall` to enable TTL-based response caching. Identical requests return the cached result without hitting the network.

```bridge
tool geo from httpCall {
  .cache = 300          # cache for 5 minutes
  .baseUrl = "https://nominatim.openstreetmap.org"
}

```

The default is an in-memory store. You can pass a custom `CacheStore` (like Redis) into `createHttpCall` when initializing the engine.
