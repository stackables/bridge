#!/usr/bin/env node
/**
 * Dumps all ExecutionTree modules into a single file for easy sharing.
 * Usage: node dump-tree.mjs > tree-dump.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = join(dirname(fileURLToPath(import.meta.url)), "src");

const files = [
  "tree-types.ts",
  "tree-utils.ts",
  "tracing.ts",
  "resolveWires.ts",
  "toolLookup.ts",
  "materializeShadows.ts",
  "scheduleTools.ts",
  "ExecutionTree.ts",
];

const SEP = "\n// " + "=".repeat(75) + "\n";

for (const file of files) {
  const src = readFileSync(join(dir, file), "utf-8");
  process.stdout.write(SEP);
  process.stdout.write(`// ${file}\n`);
  process.stdout.write(SEP);
  process.stdout.write(src.trim() + "\n");
}
