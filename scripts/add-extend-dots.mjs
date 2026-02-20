/**
 * Adds dot prefix to tool param lines inside extend/tool blocks.
 *
 * Before: `  baseUrl = "https://..."`
 * After:  `  .baseUrl = "https://..."`
 *
 * Lines NOT prefixed: `with`, `on error`, block keyword lines, comments, `}`.
 *
 * Usage: node scripts/add-extend-dots.mjs <file> [<file> ...]
 */
import { readFileSync, writeFileSync } from "node:fs";

const SKIP_PREFIXES = ["with ", "on ", "bridge ", "extend ", "tool ", "const ", "version ", "#", "}"];
const BLOCK_OPEN = /^(tool|extend)\s/i;
const BLOCK_KEYWORD = /^(tool|extend|bridge|const|version)\s/i;

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("Usage: node scripts/add-extend-dots.mjs <file> [<file> ...]");
  process.exit(1);
}

for (const file of files) {
  const original = readFileSync(file, "utf8");
  const lines = original.split("\n");
  let changed = false;
  let inExtendBlock = false;
  let braceDepth = 0;

  const result = lines.map((rawLine) => {
    const trimmed = rawLine.trim();

    // Track block entry
    if (BLOCK_OPEN.test(trimmed)) {
      inExtendBlock = true;
      braceDepth = trimmed.endsWith("{") ? 1 : 0;
      return rawLine;
    }

    // Track block entry for no-brace extends (like `extend std.pickFirst as first`)
    // These have no body so inExtendBlock immediately resets
    if (!trimmed.endsWith("{") && inExtendBlock && braceDepth === 0) {
      inExtendBlock = false;
      return rawLine;
    }

    // Track other block types that reset inExtendBlock
    if (BLOCK_KEYWORD.test(trimmed) && !BLOCK_OPEN.test(trimmed)) {
      inExtendBlock = false;
      braceDepth = 0;
      return rawLine;
    }

    // Track brace depth
    if (inExtendBlock) {
      for (const ch of trimmed) {
        if (ch === "{") braceDepth++;
        if (ch === "}" ) braceDepth--;
      }
      if (braceDepth <= 0) {
        inExtendBlock = false;
        braceDepth = 0;
        return rawLine;
      }
    }

    if (!inExtendBlock) return rawLine;

    // Skip empty, comment, or keyword-prefixed lines
    if (!trimmed || SKIP_PREFIXES.some((p) => trimmed.startsWith(p))) return rawLine;

    // Skip lines that already have a dot prefix
    if (trimmed.startsWith(".")) return rawLine;

    // Only add dot to lines that look like param assignments: identifier = value or identifier <- source
    // This guards against multi-line JSON continuation lines inside `on error = {...}`
    if (!/^[a-zA-Z]/.test(trimmed)) return rawLine;
    if (!/ = | <- /.test(trimmed)) return rawLine;

    // This is a bare param line in an extend block — add `.`
    const indent = rawLine.match(/^(\s*)/)[1];
    changed = true;
    return `${indent}.${trimmed}`;
  });

  if (changed) {
    writeFileSync(file, result.join("\n"));
    console.log(`  updated: ${file}`);
  } else {
    console.log(`  skipped: ${file} (no changes needed)`);
  }
}
