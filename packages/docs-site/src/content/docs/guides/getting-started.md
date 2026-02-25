---
title: Getting Started
description: How to write your first declarative dataflow
---

The Bridge separates your mapping logic (`.bridge` files) from your execution environment. You define the logic once, and run it wherever you need.

## 1. Write bridge-file

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

## 2. Choose Runner

### Standalone Mode

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

### GraphQL Gateway Mode

Automatically wrap The Bridge around a GraphQL schema to create an instant API Gateway.

```typescript
import { bridgeTransform, parseBridge } from "@stackables/bridge";
import { createSchema, createYoga } from "graphql-yoga";
import { readFileSync } from "node:fs";

const typeDefs = readFileSync("schema.graphql", "utf-8");
const instructions = parseBridge(readFileSync("logic.bridge", "utf-8"));

const schema = bridgeTransform(createSchema({ typeDefs }), instructions);

const yoga = createYoga({
  schema,
  context: () => ({ SENDGRID_API_KEY: process.env.SENDGRID_KEY }),
});
```
