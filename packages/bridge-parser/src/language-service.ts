/**
 * Bridge Language Service — shared intelligence layer for all consumers.
 *
 * Provides diagnostics, completions, and hover information for Bridge DSL
 * documents. Transport-agnostic: consumers (LSP server, CodeMirror, CLI)
 * are thin adapters that map these results to their own formats.
 *
 * Usage:
 *   const svc = new BridgeLanguageService();
 *   svc.update(text);
 *   svc.getDiagnostics();            // parser errors + semantic checks
 *   svc.getCompletions({ line, character });
 *   svc.getHover({ line, character });
 */
import { parseBridgeDiagnostics } from "./parser/index.ts";
import type { BridgeDiagnostic } from "./parser/index.ts";
import type { Instruction, HandleBinding } from "@stackables/bridge-core";
import { collectVersionedHandles } from "@stackables/bridge-core";
import { std, STD_VERSION } from "@stackables/bridge-stdlib";

// ── Public types ───────────────────────────────────────────────────────────

export type Position = { line: number; character: number };
export type Range = { start: Position; end: Position };

export type CompletionKind = "function" | "variable" | "keyword" | "type";

export type BridgeCompletion = {
  label: string;
  kind: CompletionKind;
  detail?: string;
  documentation?: string;
};

export type BridgeHover = {
  /** Markdown content */
  content: string;
  range?: Range;
};

// ── Internal lookup tables (built once at module load) ─────────────────────

const builtinToolNames: readonly string[] = [
  ...Object.keys(std).map((k) => `std.${k}`),
];

const builtinToolNameSet = new Set(builtinToolNames);

/** Recursively enumerate all leaf function paths in `obj` as "prefix.key" strings. */
function flattenToolPaths(obj: object, prefix: string): string[] {
  const result: string[] = [];
  for (const [key, val] of Object.entries(obj)) {
    const path = `${prefix}.${key}`;
    if (typeof val === "function") {
      result.push(path);
    } else if (typeof val === "object" && val !== null) {
      result.push(...flattenToolPaths(val, path));
    }
  }
  return result;
}

/**
 * User-facing tool names — only `std.*` leaf paths, fully qualified.
 * `internal.*` tools are engine-internal and not exposed to users.
 * e.g. ["std.str.toUpperCase", "std.str.toLowerCase", ..., "std.audit", ...]
 */
const userFacingToolNames: readonly string[] = flattenToolPaths(std, "std");

// Only validate std.* references in user code (not internal.* which is engine-only)
const BUILTIN_REF_RE = /\b(std\.[A-Za-z_]\w*)\b/g;

// ── Language Service ───────────────────────────────────────────────────────

export class BridgeLanguageService {
  private text = "";
  private lines: string[] = [];
  private instructions: Instruction[] = [];
  private startLines = new Map<Instruction, number>();
  private parserDiagnostics: BridgeDiagnostic[] = [];

  /**
   * Update the document text. Re-parses and caches the AST + diagnostics
   * so subsequent calls to getDiagnostics / getCompletions / getHover
   * reuse the same parse result.
   */
  update(text: string): void {
    this.text = text;
    this.lines = text.split("\n");

    if (!text.trim()) {
      this.instructions = [];
      this.startLines = new Map();
      this.parserDiagnostics = [];
      return;
    }

    const result = parseBridgeDiagnostics(text);
    this.instructions = result.document.instructions;
    this.startLines = result.startLines;
    this.parserDiagnostics = result.diagnostics;
  }

  // ── Diagnostics ────────────────────────────────────────────────────────

  /**
   * All diagnostics — parser errors + semantic checks (unknown tool refs, etc.)
   *
   * Ranges use 0-based lines, 0-based characters (LSP convention).
   */
  getDiagnostics(): BridgeDiagnostic[] {
    if (!this.text.trim()) return [];

    const diags = [...this.parserDiagnostics];

    // Scan for unknown std.* tool references (internal.* is engine-only; skip)
    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i];
      if (line.trimStart().startsWith("#")) continue;
      BUILTIN_REF_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = BUILTIN_REF_RE.exec(line)) !== null) {
        const ref = m[1];
        if (!builtinToolNameSet.has(ref)) {
          diags.push({
            message: `Unknown built-in tool "${ref}"`,
            severity: "error",
            range: {
              start: { line: i, character: m.index },
              end: { line: i, character: m.index + ref.length },
            },
          });
        }
      }
    }

    // Check @version tags on tool handles against the bundled std version.
    // Versions exceeding the bundled std emit a warning: the tool must be
    // provided at runtime via the tools map.
    const versioned = collectVersionedHandles(this.instructions);
    if (versioned.length > 0) {
      const stdParts = STD_VERSION.split(".").map(Number);
      const [stdMajor = 0, stdMinor = 0] = stdParts;

      for (const { name, version } of versioned) {
        if (!name.startsWith("std.")) continue;
        const vParts = version.split(".").map(Number);
        const [vMajor = 0, vMinor = 0] = vParts;
        if (vMajor === stdMajor && stdMinor >= vMinor) continue;

        // Find the line that contains this version tag so we can report it
        const versionTag = `@${version}`;
        for (let i = 0; i < this.lines.length; i++) {
          const col = this.lines[i].indexOf(versionTag);
          if (col === -1) continue;
          // Make sure it's adjacent to the tool name
          if (!this.lines[i].includes(name + versionTag)) continue;
          diags.push({
            message:
              `"${name}@${version}" exceeds bundled std ${STD_VERSION}. ` +
              `Provide this tool version at runtime via the tools map.`,
            severity: "warning",
            range: {
              start: { line: i, character: col },
              end: { line: i, character: col + versionTag.length },
            },
          });
          break;
        }
      }
    }

    return diags;
  }

  // ── Completions ────────────────────────────────────────────────────────

  /**
   * Completions at the given cursor position (0-based line/character).
   */
  getCompletions(pos: Position): BridgeCompletion[] {
    const lineText = this.lines[pos.line] ?? "";
    const textBefore = lineText.slice(0, pos.character);

    // After "std." or a deeper std path (e.g. "std.str.") → suggest next segment
    const nsPrefixMatch = textBefore.match(/\b(std(?:\.\w+)*)\.\w*$/);
    if (nsPrefixMatch) {
      const prefix = nsPrefixMatch[1] + "."; // e.g. "std." or "std.str."
      const seen = new Set<string>();
      const completions: BridgeCompletion[] = [];
      for (const fqn of userFacingToolNames) {
        if (fqn.startsWith(prefix)) {
          const rest = fqn.slice(prefix.length);
          const nextSegment = rest.split(".")[0];
          if (!seen.has(nextSegment)) {
            seen.add(nextSegment);
            const isLeaf = !rest.includes(".");
            completions.push({
              label: nextSegment,
              kind: isLeaf ? ("function" as const) : ("variable" as const),
              detail: prefix + nextSegment,
            });
          }
        }
      }
      return completions;
    }

    // After "with " at start of line or after "from " / "extends " → suggest FQN tools
    const contextMatch = textBefore.match(
      /(?:^\s*with\s+|(?:from|extends)\s+)\S*$/,
    );
    if (contextMatch) {
      return userFacingToolNames.map((fqn) => ({
        label: fqn,
        kind: "function" as const,
      }));
    }

    return [];
  }

  // ── Hover ──────────────────────────────────────────────────────────────

  /**
   * Hover information at the given cursor position (0-based line/character).
   * Returns null when there's nothing meaningful to show.
   */
  getHover(pos: Position): BridgeHover | null {
    const lineText = this.lines[pos.line] ?? "";
    const word = getWordAt(lineText, pos.character);
    if (word.length < 2) return null;
    if (this.instructions.length === 0) return null;

    // Find the instruction whose start line is closest to (but ≤) the cursor
    const cursorLineNum = pos.line + 1; // startLines are 1-based
    let closestInst = this.instructions[0];
    let closestStart = this.startLines.get(closestInst) ?? 1;

    for (const inst of this.instructions) {
      const sl = this.startLines.get(inst) ?? 1;
      if (sl <= cursorLineNum && sl >= closestStart) {
        closestStart = sl;
        closestInst = inst;
      }
    }

    // ── Bridge / Define ─────────────────────────────────────────────────
    if (closestInst.kind === "bridge" || closestInst.kind === "define") {
      const h = closestInst.handles.find((h) => h.handle === word);
      if (h) return { content: handleBindingMarkdown(h) };

      if (closestInst.kind === "bridge") {
        if (word === closestInst.type || word === closestInst.field) {
          const hc = closestInst.handles.length;
          const wc = closestInst.wires.length;
          return {
            content: `**Bridge** \`${closestInst.type}.${closestInst.field}\`\n\n${hc} handle${hc !== 1 ? "s" : ""} · ${wc} wire${wc !== 1 ? "s" : ""}`,
          };
        }
      }

      if (closestInst.kind === "define" && word === closestInst.name) {
        return {
          content: `**Define** \`${closestInst.name}\`\n\nReusable subgraph (${closestInst.handles.length} handles · ${closestInst.wires.length} wires)`,
        };
      }
    }

    // ── Tool ────────────────────────────────────────────────────────────
    if (closestInst.kind === "tool") {
      const d = closestInst.handles.find((d) => d.handle === word);
      if (d) return { content: handleBindingMarkdown(d) };

      if (
        word === closestInst.name ||
        word === closestInst.fn ||
        word === closestInst.extends
      ) {
        const fn = closestInst.fn ?? `extends ${closestInst.extends}`;
        const dc = closestInst.handles.length;
        const wc = closestInst.wires.length;
        return {
          content: `**Tool** \`${closestInst.name}\`\n\nFunction: \`${fn}\`\n\n${dc} dep${dc !== 1 ? "s" : ""} · ${wc} wire${wc !== 1 ? "s" : ""}`,
        };
      }
    }

    // ── Const ───────────────────────────────────────────────────────────
    if (closestInst.kind === "const" && word === closestInst.name) {
      return {
        content: `**Const** \`${closestInst.name}\`\n\nValue: \`${closestInst.value}\``,
      };
    }

    return null;
  }
}

// ── Utility helpers ────────────────────────────────────────────────────────

/** Extract the identifier-like word that contains `character` on `line`. */
function getWordAt(line: string, character: number): string {
  const before = line.slice(0, character).match(/[\w-]*$/)?.[0] ?? "";
  const after = line.slice(character).match(/^[\w-]*/)?.[0] ?? "";
  return before + after;
}

function handleBindingMarkdown(h: HandleBinding): string {
  switch (h.kind) {
    case "tool": {
      const ver = h.version ? ` @${h.version}` : "";
      return `**Tool handle** \`${h.handle}\`\n\nSource: \`${h.name}${ver}\``;
    }
    case "input":
      return `**Input handle** \`${h.handle}\`\n\nGraphQL field arguments`;
    case "output":
      return `**Output handle** \`${h.handle}\`\n\nGraphQL field return value`;
    case "context":
      return `**Context handle** \`${h.handle}\`\n\nGraphQL execution context`;
    case "const":
      return `**Const handle** \`${h.handle}\`\n\nNamed constants declared in this file`;
    case "define":
      return `**Define handle** \`${h.handle}\`\n\nInlined from \`define ${h.name}\``;
  }
}
