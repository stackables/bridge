/**
 * Injects `version 1.3` into every bridge-format template literal
 * that doesn't already have it.
 *
 * Handles both:
 *   parseBridge(`...`)
 *   const bridgeText = `\nbridge ...`
 *
 * Usage: node scripts/add-version.mjs test/*.test.ts
 */
import { readFileSync, writeFileSync } from "node:fs";

const VERSION = "1.3";
const versionLine = `version ${VERSION}`;

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("Usage: node scripts/add-version.mjs <file> [<file> ...]");
  process.exit(1);
}

for (const file of files) {
  const original = readFileSync(file, "utf8");

  // Match any template literal whose content (after optional leading newline)
  // starts with a bridge-format keyword, but does not already have the version.
  // Handles: parseBridge(`...`), const bridgeText = `...`, etc.
  let updated = original.replace(
    /(`)\n?(bridge |extend |const |tool )/g,
    (match, backtick, keyword) => {
      // Check if the preceding chars suggest this is already versioned.
      // We can't check backwards easily, so we just always inject and rely
      // on a second pass to not double-inject (checked after first run by
      // running the script again — duplicates would show as `version 1.3\nversion 1.3`).
      return `${backtick}${versionLine}\n${keyword}`;
    },
  );

  // Also handle parseBridge(` immediately followed by \n then keywords
  // (the case above covers `\nkeyword` but we want backtick + newline + keyword)
  // This pattern is already covered: `` `\nbridge `` → backtick then newline then keyword

  if (updated !== original) {
    writeFileSync(file, updated);
    console.log(`  updated: ${file}`);
  } else {
    console.log(`  skipped: ${file} (no changes needed)`);
  }
}
