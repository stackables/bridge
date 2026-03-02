/**
 * Bridge GraphQL — graphql-yoga server with bridgeTransform.
 *
 * Endpoints:
 *   POST /graphql  — GraphQL endpoint
 *   GET  /health   — health check
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createSchema, createYoga } from "graphql-yoga";
import { bridgeTransform, parseBridge } from "@stackables/bridge";

const PORT = parseInt(process.env.PORT || "3000", 10);

const typeDefs = readFileSync(
  new URL("./schema.graphql", import.meta.url),
  "utf-8",
);

const document = parseBridge(
  readFileSync(new URL("./endpoints.bridge", import.meta.url), "utf-8"),
);

const schema = bridgeTransform(createSchema({ typeDefs }), document);

const yoga = createYoga({
  schema,
  graphqlEndpoint: "/graphql",
  logging: false,
});

// Wrap yoga with health check
const server = createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"status":"ok"}');
    return;
  }

  // Delegate to yoga
  const response = await yoga.fetch(`http://localhost:${PORT}${req.url}`, {
    method: req.method!,
    headers: req.headers as Record<string, string>,
    body:
      req.method === "POST"
        ? await new Promise<string>((resolve) => {
            let data = "";
            req.on("data", (chunk: Buffer) => {
              data += chunk.toString();
            });
            req.on("end", () => resolve(data));
          })
        : undefined,
  });

  res.writeHead(
    response.status,
    Object.fromEntries(response.headers.entries()),
  );
  const body = await response.text();
  res.end(body);
});

server.listen(PORT, () => {
  console.log(`Bridge GraphQL server listening on :${PORT}`);
});
