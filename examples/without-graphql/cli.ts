/**
 * Generic Bridge CLI runner — execute any .bridge file without a GraphQL server.
 *
 * Usage:
 *   node --import tsx/esm cli.ts <bridge-file> [input-json] [--operation Type.field] [--trace]
 *
 * Examples:
 *   node --import tsx/esm cli.ts weather.bridge '{"city":"Berlin"}'
 *   node --import tsx/esm cli.ts sbb.bridge '{"from":"Bern","to":"Zürich"}' --trace
 *   node --import tsx/esm cli.ts sbb.bridge '{"from":"Basel","to":"Luzern"}' --operation Query.searchTrains
 */

import { readFileSync } from "node:fs";
import { parseBridgeDiagnostics, executeBridge } from "@stackables/bridge";
import type { Bridge } from "@stackables/bridge";

// ── Parse CLI arguments ────────────────────────────────────────────────────
const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  console.log(
    `
Usage: node --import tsx/esm cli.ts <bridge-file> [input-json] [options]

Options:
  --operation <Type.field>   Which bridge to run (default: first bridge in file)
  --trace                    Print tool call traces after the result
  -h, --help                 Show this help

Examples:
  node --import tsx/esm cli.ts weather.bridge '{"city":"Berlin"}'
  node --import tsx/esm cli.ts sbb.bridge '{"from":"Bern","to":"Zürich"}' --trace
`.trim(),
  );
  process.exit(0);
}

const bridgeFile = args[0]!;
let inputArg = "{}";
let operationOverride: string | undefined;
let enableTrace = false;

for (let i = 1; i < args.length; i++) {
  if (args[i] === "--operation" && args[i + 1]) {
    operationOverride = args[++i];
  } else if (args[i] === "--trace") {
    enableTrace = true;
  } else if (!args[i]!.startsWith("--")) {
    inputArg = args[i]!;
  }
}

// ── Load and parse the bridge file ────────────────────────────────────────
const source = readFileSync(bridgeFile, "utf8");
const { document, diagnostics } = parseBridgeDiagnostics(source);

const errors = diagnostics.filter((d) => d.severity === "error");
if (errors.length > 0) {
  console.error("Parse errors in", bridgeFile);
  for (const e of errors) {
    console.error(`  Line ${e.range.start.line + 1}: ${e.message}`);
  }
  process.exit(1);
}

// ── Resolve the operation name ─────────────────────────────────────────────
const bridges = document.instructions.filter(
  (i): i is Bridge => i.kind === "bridge",
);

if (bridges.length === 0) {
  console.error(`No bridge definitions found in ${bridgeFile}`);
  process.exit(1);
}

const operation =
  operationOverride ?? `${bridges[0]!.type}.${bridges[0]!.field}`;

if (bridges.length > 1 && !operationOverride) {
  const others = bridges
    .slice(1)
    .map((b) => `${b.type}.${b.field}`)
    .join(", ");
  console.error(
    `Note: Multiple bridges found. Running "${operation}". Others: ${others}`,
  );
  console.error(
    `      Use --operation <Type.field> to pick a different one.\n`,
  );
}

// ── Parse the input ────────────────────────────────────────────────────────
let input: Record<string, unknown>;
try {
  input = JSON.parse(inputArg);
} catch {
  console.error(`Invalid JSON input: ${inputArg}`);
  process.exit(1);
}

// ── Execute ───────────────────────────────────────────────────────────────
console.error(
  `▶  Running bridge "${operation}" with input:`,
  JSON.stringify(input),
);
console.error("");

const start = Date.now();
const { data, traces } = await executeBridge({
  document,
  operation,
  input,
  trace: enableTrace ? "full" : "off",
});
const elapsed = Date.now() - start;

// ── Output ─────────────────────────────────────────────────────────────────
console.log(JSON.stringify(data, null, 2));

console.error(`\n✓  Done in ${elapsed}ms`);

if (enableTrace && traces.length > 0) {
  console.error("\nTool traces:");
  for (const t of traces) {
    const status = t.error ? "✗" : "✓";
    console.error(`  ${status} ${t.tool}  ${t.durationMs}ms`);
    if (t.error) console.error(`    Error: ${t.error}`);
  }
}
