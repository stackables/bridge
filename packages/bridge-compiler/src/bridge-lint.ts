#!/usr/bin/env node
/**
 * bridge-lint — CLI tool to lint .bridge files.
 *
 * Usage:
 *   bridge-lint <file.bridge> [file2.bridge ...]
 *   bridge-lint *.bridge
 *
 * Exits with code 1 if any file has errors, 0 otherwise.
 *
 * Uses the shared BridgeLanguageService — same intelligence as the
 * VS Code extension and the playground editor.
 */
import { readFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import { BridgeLanguageService } from "./language-service.ts";

const args = process.argv.slice(2);

if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: bridge-lint <file.bridge> [file2.bridge ...]

Lint Bridge DSL files and report diagnostics.

Options:
  --help, -h   Show this help message
  --json       Output diagnostics as JSON`);
  process.exit(0);
}

const jsonOutput = args.includes("--json");
const files = args.filter((a) => !a.startsWith("-"));

const svc = new BridgeLanguageService();
let hasErrors = false;

interface JsonDiagnostic {
  file: string;
  line: number;
  character: number;
  severity: string;
  message: string;
}

const allJsonDiags: JsonDiagnostic[] = [];

for (const rawPath of files) {
  const filePath = resolve(rawPath);
  let text: string;
  try {
    text = readFileSync(filePath, "utf-8");
  } catch (err) {
    console.error(`Error reading ${rawPath}: ${(err as Error).message}`);
    hasErrors = true;
    continue;
  }

  svc.update(text);
  const diags = svc.getDiagnostics();

  if (diags.length === 0) continue;

  const relPath = relative(process.cwd(), filePath);

  for (const d of diags) {
    if (d.severity === "error") hasErrors = true;

    if (jsonOutput) {
      allJsonDiags.push({
        file: relPath,
        line: d.range.start.line + 1,
        character: d.range.start.character + 1,
        severity: d.severity,
        message: d.message,
      });
    } else {
      const sev =
        d.severity === "error"
          ? "\x1b[31merror\x1b[0m"
          : "\x1b[33mwarning\x1b[0m";
      const loc = `${d.range.start.line + 1}:${d.range.start.character + 1}`;
      console.log(`${relPath}:${loc} ${sev} ${d.message}`);
    }
  }
}

if (jsonOutput) {
  console.log(JSON.stringify(allJsonDiags, null, 2));
}

process.exit(hasErrors ? 1 : 0);
