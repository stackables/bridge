#!/usr/bin/env node

/**
 * Smoke-test published package artifacts.
 *
 * Strategy:
 *   1. `pnpm build`           (must already be done — we just verify)
 *   2. `pnpm pack` every @stackables/* package into tarballs
 *   3. Create a temp directory with its own package.json
 *   4. `npm install` the tarballs (resolves inter-package deps via tarballs)
 *   5. Run a small ESM script that imports every public export and
 *      performs a parse → execute round-trip
 *   6. Run `tsc --noEmit` against a tiny .ts file to verify type declarations
 *   7. Clean up (or leave on failure for debugging)
 *
 * Run:   node scripts/smoke-test-packages.mjs
 * CI:    runs after `pnpm build`, before `pnpm ci:publish`
 */

import { execSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  readdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// ── Helpers ─────────────────────────────────────────────────────────────────

function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`);
  return execSync(cmd, { encoding: "utf8", stdio: "pipe", ...opts });
}

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

// ── 1. Discover publishable packages ────────────────────────────────────────

const packagesDir = join(root, "packages");
const publishable = [];

for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const pkgPath = join(packagesDir, entry.name, "package.json");
  if (!existsSync(pkgPath)) continue;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (pkg.name?.startsWith("@stackables/") && !pkg.private) {
    publishable.push({
      name: pkg.name,
      dir: join(packagesDir, entry.name),
      pkg,
    });
  }
}

if (publishable.length === 0) fail("No publishable packages found");
console.log(`\nFound ${publishable.length} publishable packages:`);
for (const p of publishable) console.log(`  • ${p.name}@${p.pkg.version}`);

// ── 2. Verify build output exists ───────────────────────────────────────────

for (const p of publishable) {
  const buildDir = join(p.dir, "build");
  if (!existsSync(buildDir)) {
    fail(`${p.name}: build/ directory missing — run "pnpm build" first`);
  }
}

// ── 3. Pack every package ───────────────────────────────────────────────────

console.log("\nPacking tarballs…");
const tarballs = new Map(); // name → absolute path to .tgz

for (const p of publishable) {
  const out = run("pnpm pack --pack-destination /tmp/bridge-smoke", {
    cwd: p.dir,
  }).trim();
  // pnpm pack prints the tarball filename
  const tgz = out.split("\n").pop().trim();
  const absPath = resolve(
    tgz.startsWith("/") ? tgz : join("/tmp/bridge-smoke", tgz),
  );
  if (!existsSync(absPath))
    fail(`pack produced no tarball for ${p.name}: ${absPath}`);
  tarballs.set(p.name, absPath);
  console.log(`  ✓ ${p.name} → ${absPath}`);
}

// ── 4. Create temp project ──────────────────────────────────────────────────

const tempDir = mkdtempSync(join(tmpdir(), "bridge-smoke-"));
console.log(`\nTemp project: ${tempDir}`);

// Build dependency list using tarball paths
// Install only the umbrella — it depends on all others, npm will need them too
const deps = {};
for (const [name, tgz] of tarballs) {
  deps[name] = `file:${tgz}`;
}

writeFileSync(
  join(tempDir, "package.json"),
  JSON.stringify(
    {
      name: "bridge-smoke-test",
      private: true,
      type: "module",
      dependencies: {
        ...deps,
        // peer deps required by bridge-graphql
        graphql: "^16.0.0",
        "@graphql-tools/utils": "^11.0.0",
      },
      devDependencies: {
        typescript: "^5.9.0",
      },
    },
    null,
    2,
  ),
);

console.log("\nInstalling tarballs…");
run("npm install --ignore-scripts", { cwd: tempDir });

// ── 5. Runtime smoke test (ESM) ─────────────────────────────────────────────

const smokeScript = `
import { parseBridgeFormat, executeBridge } from "@stackables/bridge";
import { ExecutionTree } from "@stackables/bridge-core";
import { parseBridgeChevrotain, serializeBridge } from "@stackables/bridge-compiler";
import { createHttpCall, std } from "@stackables/bridge-stdlib";
import { bridgeTransform } from "@stackables/bridge-graphql";

// --- Parse round-trip ---
const source = \`version 1.5
bridge Query.hello {
  with input as i
  with output as o
  with upper

  upper.text <- i.name
  o.greeting <- upper.result
}
\`;

const doc = parseBridgeFormat(source);
if (!doc || !doc.instructions || doc.instructions.length === 0)
  throw new Error("parseBridgeFormat returned empty document");

const bridge = doc.instructions.find(i => i.kind === "bridge");
if (!bridge) throw new Error("No bridge instruction found");
if (bridge.type !== "Query" || bridge.field !== "hello")
  throw new Error("Unexpected bridge type/field");

// --- Serialize round-trip ---
const serialized = serializeBridge(doc);
if (typeof serialized !== "string" || !serialized.includes("bridge Query.hello"))
  throw new Error("serializeBridge produced invalid output");

const reparsed = parseBridgeFormat(serialized);
if (reparsed.instructions.length !== doc.instructions.length)
  throw new Error("Round-trip changed instruction count");

// --- Execute bridge ---
const result = await executeBridge({
  document: doc,
  operation: "Query.hello",
  input: { name: "world" },
  tools: {
    upper: async (payload) => ({ result: String(payload.text).toUpperCase() }),
  },
});

if (result.data?.greeting !== "WORLD")
  throw new Error(\`Expected "WORLD", got \${JSON.stringify(result.data)}\`);

// --- Verify stdlib exports ---
if (typeof createHttpCall !== "function") throw new Error("createHttpCall not exported");
if (!std || typeof std !== "object") throw new Error("std namespace missing");
if (typeof std.httpCall !== "function") throw new Error("std.httpCall missing");

// --- Verify types at runtime shapes ---
if (typeof ExecutionTree !== "function") throw new Error("ExecutionTree not exported");
if (typeof bridgeTransform !== "function") throw new Error("bridgeTransform not exported");

console.log("✓ All runtime smoke tests passed");
`;

writeFileSync(join(tempDir, "smoke.mjs"), smokeScript);

console.log("\nRunning runtime smoke test…");
try {
  const output = run(`node smoke.mjs`, { cwd: tempDir });
  console.log(output);
} catch (e) {
  console.error(e.stdout || "");
  console.error(e.stderr || "");
  fail("Runtime smoke test failed");
}

// ── 6. Type-checking smoke test ─────────────────────────────────────────────

const typeCheckScript = `
import { parseBridgeFormat, executeBridge, serializeBridge } from "@stackables/bridge";
import type { Bridge, BridgeDocument, Wire, NodeRef, ToolDef, ToolMap, ToolCallFn, ToolContext } from "@stackables/bridge";
import type { ExecuteBridgeOptions, ExecuteBridgeResult } from "@stackables/bridge";

// Verify key type shapes compile
const doc: BridgeDocument = parseBridgeFormat("version 1.5\\nbridge Query.x { with input as i\\nwith output as o }");
const bridges: Bridge[] = doc.instructions.filter((i): i is Bridge => i.kind === "bridge");
const toolMap: ToolMap = { myTool: async (p: Record<string, unknown>) => ({ ok: true }) };

async function testExec(): Promise<void> {
  const result: ExecuteBridgeResult = await executeBridge({
    document: doc,
    operation: "Query.x",
    input: {},
    tools: toolMap,
  });
  const data = result.data;
  console.log(data);
}
`;

writeFileSync(join(tempDir, "smoke-types.ts"), typeCheckScript);

writeFileSync(
  join(tempDir, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "Node16",
        moduleResolution: "Node16",
        strict: true,
        noEmit: true,
        skipLibCheck: false, // we want to check our .d.ts files
      },
      include: ["smoke-types.ts"],
    },
    null,
    2,
  ),
);

console.log("Running type-check smoke test…");
try {
  run("npx tsc --noEmit", { cwd: tempDir });
  console.log("  ✓ Type declarations compile cleanly");
} catch (e) {
  console.error(e.stdout || "");
  console.error(e.stderr || "");
  fail("Type-check smoke test failed");
}

// ── 7. Cleanup ──────────────────────────────────────────────────────────────

console.log("\nCleaning up…");
rmSync(tempDir, { recursive: true, force: true });
rmSync("/tmp/bridge-smoke", { recursive: true, force: true });
console.log("✓ All smoke tests passed — packages are publish-ready\n");
