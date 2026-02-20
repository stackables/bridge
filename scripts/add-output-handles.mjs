/**
 * Script to add `with output as o` and prefix bare output wire LHS with `o.`
 * in all bridge blocks across test files.
 *
 * Usage: node scripts/add-output-handles.mjs [file ...]
 */
import fs from "node:fs";
import path from "node:path";

const files = process.argv.slice(2);

for (const filePath of files) {
  let text = fs.readFileSync(filePath, "utf8");
  const updated = transformBridgeBlocks(text);
  if (updated !== text) {
    fs.writeFileSync(filePath, updated);
    console.log(`Updated: ${filePath}`);
  } else {
    console.log(`No changes: ${filePath}`);
  }
}

function transformBridgeBlocks(text) {
  // Match bridge blocks: from 'bridge X.Y {' to the matching closing '}'
  // We work line-by-line to handle nesting properly.
  const lines = text.split("\n");
  const result = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    // Start of a bridge block?
    if (/^bridge\s+\S+\.\S+\s*\{/.test(line.trim())) {
      // Collect the block
      const blockStart = i;
      const blockLines = [line];
      i++;
      // Read until matching close: a line that is just '}'
      while (i < lines.length) {
        blockLines.push(lines[i]);
        if (/^\}/.test(lines[i])) {
          i++;
          break;
        }
        i++;
      }
      // Transform the block
      const transformed = updateBridgeBlock(blockLines);
      result.push(...transformed);
    } else {
      result.push(line);
      i++;
    }
  }

  return result.join("\n");
}

function updateBridgeBlock(blockLines) {
  // Parse declared handles
  const handles = new Set();
  for (const line of blockLines) {
    const m = line.trim().match(/^with\s+(\S+)(?:\s+as\s+(\S+))?$/i);
    if (m) {
      const handle = m[2] ?? m[1].split(".").pop();
      handles.add(handle);
    }
  }

  // If output already declared, return unchanged
  if ([...handles].some((h) => h === "o" || h === "output")) {
    return blockLines;
  }

  // Insert 'with output as o' after last 'with' line
  let lastWithIdx = -1;
  for (let i = 0; i < blockLines.length; i++) {
    if (/^\s+with\s/i.test(blockLines[i])) lastWithIdx = i;
  }
  if (lastWithIdx === -1) return blockLines; // no with lines

  const result = [...blockLines];
  result.splice(lastWithIdx + 1, 0, "  with output as o");
  handles.add("o");

  // Prefix bare output wire LHS with 'o.'
  const knownPrefixes = [...handles];
  for (let i = 0; i < result.length; i++) {
    const line = result[i];
    const wireMatch = line.match(/^([A-Za-z][A-Za-z0-9_]*)(\.\S*)?\s+(<-!?|=)\s/);
    if (!wireMatch) continue;
    const lhsRoot = wireMatch[1];
    if (knownPrefixes.includes(lhsRoot) || lhsRoot === "on") continue;
    // Bare output ref — prefix with 'o.'
    result[i] = line.replace(/^([A-Za-z][A-Za-z0-9_]*)/, "o.$1");
  }

  return result;
}
