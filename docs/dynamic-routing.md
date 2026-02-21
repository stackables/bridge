## Dynamic Routing & Context-Aware Topologies

By default, `bridgeTransform` takes a parsed `.bridge` file and attaches it to your schema statically. But for enterprise gateways, multi-tenant SaaS, and strict compliance environments, a static graph isn't enough.

The Bridge supports **Context-Aware Topology Switching**. Instead of passing a static array of instructions, you can pass a router function: `(context: any) => Instruction[]`.

This function is evaluated **per-request**, allowing you to hot-swap the entire physical wiring of your GraphQL API based on the user's identity, region, or billing tier—without writing a single `if/else` statement in your business logic.

### How it works

When a request hits your GraphQL server, the engine passes the GraphQL `context` to your router function. The function returns the specific `.bridge` AST that should execute for that exact request.

```typescript
import { bridgeTransform, parseBridge } from "@stackables/bridge";

// 1. Parse your different topologies at startup
const euBridge = parseBridge(fs.readFileSync("eu-infrastructure.bridge"));
const usBridge = parseBridge(fs.readFileSync("us-infrastructure.bridge"));

// 2. Define the dynamic router
const schema = bridgeTransform(baseSchema, (context) => {
  // Read the user's region from the request context
  if (context.user.region === "EU") {
    return euBridge; 
  }
  return usBridge;
});

```

### Why use Dynamic Routing?

By keeping the routing logic in the host server and the data mapping in the `.bridge` files, you achieve a perfect separation of concerns between Platform Engineering and Product Development.

#### 1. Data Sovereignty & Compliance (GDPR)

Ensure EU users never accidentally touch US servers. If the `context` dictates the EU bridge, the US endpoints physically do not exist in the execution graph for that request. It is mathematically impossible for data to leak to the wrong region.

#### 2. Tiered SLAs (Free vs. Pro)

Swap expensive tools for cheap ones based on billing.

```typescript
const schema = bridgeTransform(baseSchema, (context) => {
  // Pro users get real-time GPT-4; Free users get a cached/smaller model
  return context.user.plan === "PRO" ? premiumBridge : budgetBridge;
});

```

#### 3. Canary Releases & A/B Testing

Safely migrate between external API providers (e.g., swapping SendGrid for Postmark) by routing a small percentage of traffic to the new topology.

```typescript
const schema = bridgeTransform(baseSchema, (context) => {
  // Route 5% of traffic to the experimental v2 pipeline
  return Math.random() < 0.05 ? experimentalBridge : stableBridge;
});

```

### Security Note

Because `.bridge` files are parsed into serializable ASTs (`Instruction[]`), the router function is incredibly fast. Evaluating the context and returning an in-memory AST array adds virtually zero latency to your request pipeline, making it ideal for high-throughput edge gateways.
