#!/usr/bin/env node
/**
 * Generate static JSON fixtures for the dependency emulator (nginx).
 *
 * Run:  node loadtest/scripts/generate-data.mjs
 *
 * Produces files in loadtest/dependency/data/
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(root, "dependency", "data");
mkdirSync(dataDir, { recursive: true });

// ── simple.json ─────────────────────────────────────────────────────────
const simple = {
  id: 42,
  first_name: "John",
  last_name: "Doe",
  email_address: "john.doe@example.com",
  date_of_birth: "1990-05-15",
  role: "Senior Engineer",
  department_info: {
    name: "Engineering",
    code: "ENG-001",
    building: "B3",
    floor: 4,
  },
};
writeFileSync(join(dataDir, "simple.json"), JSON.stringify(simple));

// ── list.json ── 1000 items ─────────────────────────────────────────────
const categories = [
  "electronics",
  "clothing",
  "food",
  "tools",
  "furniture",
  "toys",
  "books",
  "sports",
  "garden",
  "automotive",
];
const list = Array.from({ length: 1000 }, (_, i) => ({
  item_id: i + 1,
  item_name: `Widget ${String.fromCharCode(65 + (i % 26))}${Math.floor(i / 26) + 1}`,
  item_category: categories[i % categories.length],
  unit_price: parseFloat((10 + ((i * 17 + 7) % 990)).toFixed(2)),
  in_stock: i % 7 !== 0,
  supplier_code: `SUP-${String((i % 20) + 1).padStart(3, "0")}`,
}));
writeFileSync(join(dataDir, "list.json"), JSON.stringify(list));

// ── catalog.json ── 1000 entries, 10 unique variant_ids ─────────────────
const warehouses = ["WH-A", "WH-B", "WH-C", "WH-D", "WH-E"];
const catalog = Array.from({ length: 1000 }, (_, i) => ({
  entry_id: i + 1,
  variant_id: (i % 10) + 1,
  quantity: ((i * 7 + 3) % 50) + 1,
  warehouse: warehouses[i % warehouses.length],
}));
writeFileSync(join(dataDir, "catalog.json"), JSON.stringify(catalog));

// ── variant-1.json … variant-10.json ────────────────────────────────────
const variantNames = [
  "Alpha",
  "Beta",
  "Gamma",
  "Delta",
  "Epsilon",
  "Zeta",
  "Eta",
  "Theta",
  "Iota",
  "Kappa",
];
for (let i = 1; i <= 10; i++) {
  const variant = {
    variant_id: i,
    variant_name: `Variant ${variantNames[i - 1]}`,
    description: `Premium ${variantNames[i - 1].toLowerCase()} variant with enhanced features and quality materials`,
    base_price: parseFloat((20 + i * 15.5).toFixed(2)),
    weight_kg: parseFloat((0.5 + i * 0.3).toFixed(2)),
    dimensions: { length: 10 + i * 2, width: 8 + i, height: 5 + i },
    tags: [
      "premium",
      i % 2 === 0 ? "bestseller" : "new",
      variantNames[i - 1].toLowerCase(),
    ],
  };
  writeFileSync(join(dataDir, `variant-${i}.json`), JSON.stringify(variant));
}

console.log("✓ Generated data files in", dataDir);
