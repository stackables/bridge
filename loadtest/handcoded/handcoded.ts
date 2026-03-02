/**
 * Hand-coded Node.js — baseline HTTP server doing the same work manually.
 *
 * Endpoints:
 *   GET /simple   — fetch + field mapping
 *   GET /array    — fetch + array mapping (1000 items)
 *   GET /complex  — fetch catalog + fan-out variant sub-requests (dedup)
 *   GET /health   — health check
 */

import { createServer } from "node:http";

const PORT = parseInt(process.env.PORT || "3000", 10);
const DEP = process.env.DEPENDENCY_URL || "http://dependency:8080";

// ── Simple ──────────────────────────────────────────────────────────────

async function handleSimple(): Promise<string> {
  const res = await fetch(`${DEP}/api/simple`);
  const emp = (await res.json()) as any;
  return JSON.stringify({
    id: emp.id,
    firstName: emp.first_name,
    lastName: emp.last_name,
    email: emp.email_address,
    role: emp.role,
    department: emp.department_info.name,
    building: emp.department_info.building,
  });
}

// ── Array ───────────────────────────────────────────────────────────────

async function handleArray(): Promise<string> {
  const res = await fetch(`${DEP}/api/list`);
  const list = (await res.json()) as any[];
  return JSON.stringify({
    items: list.map((item) => ({
      id: item.item_id,
      name: item.item_name,
      category: item.item_category,
      price: item.unit_price,
    })),
  });
}

// ── Complex ─────────────────────────────────────────────────────────────

async function handleComplex(): Promise<string> {
  // 3 parallel fetches — same as what the bridge engine does
  const [simpleRes, _listRes, catalogRes] = await Promise.all([
    fetch(`${DEP}/api/simple`),
    fetch(`${DEP}/api/list`),
    fetch(`${DEP}/api/catalog`),
  ]);

  const emp = (await simpleRes.json()) as any;
  const list = (await _listRes.json()) as any[];
  const catalog = (await catalogRes.json()) as any[];

  return JSON.stringify({
    assignee: emp.first_name,
    email: emp.email_address,
    department: emp.department_info.name,
    topItem: list[0].item_name,
    entries: catalog.map((entry) => ({
      entryId: entry.entry_id,
      variantId: entry.variant_id,
      quantity: entry.quantity,
      warehouse: entry.warehouse,
    })),
  });
}

// ── Server ──────────────────────────────────────────────────────────────

const handlers: Record<string, () => Promise<string>> = {
  "/simple": handleSimple,
  "/array": handleArray,
  "/complex": handleComplex,
};

const server = createServer(async (req, res) => {
  try {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"status":"ok"}');
      return;
    }

    const handler = handlers[req.url ?? ""];
    if (!handler) {
      res.writeHead(404);
      res.end('{"error":"not found"}');
      return;
    }

    const body = await handler();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
  } catch (err) {
    console.error("Error:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(err) }));
  }
});

server.listen(PORT, () => {
  console.log(`Hand-coded server listening on :${PORT}`);
});
