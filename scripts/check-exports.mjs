#!/usr/bin/env node

/**
 * Validates that every publishable package's exported entry points
 * (main, types, and all export-map conditions) resolve to real files
 * after `pnpm build`.
 *
 * This catches the rootDir-drift bug where tsc outputs nested folders
 * (e.g. build/bridge-core/src/) instead of flat build/ output.
 *
 * Run: node scripts/check-exports.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// Read pnpm workspace to find packages
const packageDirs = [];

// Find all publishable package.json files (those with a "name" starting with @stackables/)
import { readdirSync } from "node:fs";

function findPublishablePackages(baseDir) {
  const entries = readdirSync(baseDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pkgJsonPath = join(baseDir, entry.name, "package.json");
    if (existsSync(pkgJsonPath)) {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
      if (pkg.name?.startsWith("@stackables/") && !pkg.private) {
        packageDirs.push({
          name: pkg.name,
          dir: join(baseDir, entry.name),
          pkg,
        });
      }
    }
  }
}

findPublishablePackages(join(root, "packages"));

let errors = 0;

for (const { name, dir, pkg } of packageDirs) {
  const filesToCheck = [];

  // Collect main and types
  if (pkg.main) filesToCheck.push({ field: "main", file: pkg.main });
  if (pkg.types) filesToCheck.push({ field: "types", file: pkg.types });

  // Collect all export conditions (except "source" which points to src/)
  if (pkg.exports) {
    for (const [exportPath, conditions] of Object.entries(pkg.exports)) {
      if (typeof conditions === "string") {
        filesToCheck.push({
          field: `exports["${exportPath}"]`,
          file: conditions,
        });
      } else if (typeof conditions === "object") {
        for (const [condition, file] of Object.entries(conditions)) {
          if (condition === "source") continue; // source points to src/, skip
          filesToCheck.push({
            field: `exports["${exportPath}"].${condition}`,
            file,
          });
        }
      }
    }
  }

  for (const { field, file } of filesToCheck) {
    const resolved = resolve(dir, file);
    if (!existsSync(resolved)) {
      console.error(`  ✗ ${name} → ${field}: ${file} does not exist`);
      errors++;
    } else {
      console.log(`  ✓ ${name} → ${field}: ${file}`);
    }
  }
}

console.log();
if (errors > 0) {
  console.error(
    `✗ ${errors} missing export(s) detected. Build output is broken.`,
  );
  process.exit(1);
} else {
  console.log(`✓ All package exports verified.`);
}
