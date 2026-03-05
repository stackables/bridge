/**
 * Bridge Standalone (no GraphQL) — HTTP server using executeBridge.
 *
 * Endpoints:
 *   GET /simple   — fetch + field mapping
 *   GET /array    — fetch + array mapping (100 items)
 *   GET /complex  — fetch catalog + fan-out variant sub-requests
 *   GET /health   — health check
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { parseBridge } from "@stackables/bridge";
import { executeBridge } from "@stackables/bridge-compiler";

const PORT = parseInt(process.env.PORT || "3000", 10);

const document = parseBridge(
  readFileSync(new URL("./endpoints.bridge", import.meta.url), "utf-8"),
);

const server = createServer(async (req, res) => {
  try {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"status":"ok"}');
      return;
    }

    const operations: Record<string, string> = {
      "/simple": "Query.simple",
      "/array": "Query.arrayMap",
      "/complex": "Query.complex",
    };

    const operation = operations[req.url ?? ""];
    if (!operation) {
      res.writeHead(404);
      res.end('{"error":"not found"}');
      return;
    }

    const { data } = await executeBridge({ document, operation });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  } catch (err) {
    console.error("Error:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(err) }));
  }
});

server.listen(PORT, () => {
  console.log(`Bridge standalone listening on :${PORT}`);
});
