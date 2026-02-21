/**
 * Bridge Language Server — provides LSP features for .bridge files.
 *
 * Runs as a standalone Node.js process spawned by the extension client.
 * Communicates via IPC using the Language Server Protocol.
 *
 * Features:
 *   • Real-time diagnostics  (syntax errors + semantic validation)
 *   • Hover information      (handle bindings, bridge/tool declarations)
 */
import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  type InitializeResult,
  TextDocumentSyncKind,
  DiagnosticSeverity,
  type Hover,
  MarkupKind,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { parseBridgeDiagnostics } from "@stackables/bridge";
import type { HandleBinding, ToolDep } from "@stackables/bridge";

// ── Connection & document manager ──────────────────────────────────────────

const connection = createConnection(ProposedFeatures.all);
const documents  = new TextDocuments(TextDocument);

connection.onInitialize((): InitializeResult => ({
  capabilities: {
    textDocumentSync: TextDocumentSyncKind.Incremental,
    hoverProvider: true,
  },
}));

// ── Diagnostics ────────────────────────────────────────────────────────────

function validate(doc: TextDocument): void {
  const text = doc.getText();

  // Empty / whitespace-only file — clear any previous diagnostics
  if (!text.trim()) {
    connection.sendDiagnostics({ uri: doc.uri, diagnostics: [] });
    return;
  }

  const { diagnostics } = parseBridgeDiagnostics(text);

  connection.sendDiagnostics({
    uri: doc.uri,
    diagnostics: diagnostics.map(d => ({
      severity: d.severity === "error"
        ? DiagnosticSeverity.Error
        : DiagnosticSeverity.Warning,
      range:   d.range,
      message: d.message,
      source:  "bridge",
    })),
  });
}

documents.onDidChangeContent(change => validate(change.document));
documents.onDidOpen(e => validate(e.document));
documents.onDidClose(e =>
  connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] }),
);

// ── Hover ──────────────────────────────────────────────────────────────────

/** Extract the identifier-like word that contains `character` on `line`. */
function getWordAt(line: string, character: number): string {
  const before = line.slice(0, character).match(/[\w-]*$/)?.[0]  ?? "";
  const after  = line.slice(character).match(/^[\w-]*/)?.[0]     ?? "";
  return before + after;
}

function handleBindingMarkdown(h: HandleBinding): string {
  switch (h.kind) {
    case "tool":    return `**Tool handle** \`${h.handle}\`\n\nSource: \`${h.name}\``;
    case "input":   return `**Input handle** \`${h.handle}\`\n\nGraphQL field arguments`;
    case "output":  return `**Output handle** \`${h.handle}\`\n\nGraphQL field return value`;
    case "context": return `**Context handle** \`${h.handle}\`\n\nGraphQL execution context`;
    case "const":   return `**Const handle** \`${h.handle}\`\n\nNamed constants declared in this file`;
    case "define":  return `**Define handle** \`${h.handle}\`\n\nInlined from \`define ${h.name}\``;
  }
}

function toolDepMarkdown(d: ToolDep): string {
  switch (d.kind) {
    case "context": return `**Context dep** \`${d.handle}\`\n\nGraphQL execution context`;
    case "const":   return `**Const dep** \`${d.handle}\`\n\nNamed constants declared in this file`;
    case "tool":    return `**Tool dep** \`${d.handle}\`\n\nTool: \`${d.tool}\``;
  }
}

connection.onHover((params): Hover | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;

  const text  = doc.getText();
  const lines = text.split("\n");
  const cursorLine = lines[params.position.line] ?? "";
  const word = getWordAt(cursorLine, params.position.character);
  if (word.length < 2) return null;

  const { instructions, startLines } = parseBridgeDiagnostics(text);
  if (instructions.length === 0) return null;

  // Find the instruction whose start line is closest to (but ≤) the cursor
  // (1-based cursor line: params.position.line is 0-based)
  const cursorLineNum = params.position.line + 1;
  let closestInst    = instructions[0];
  let closestStart   = startLines.get(closestInst) ?? 1;

  for (const inst of instructions) {
    const sl = startLines.get(inst) ?? 1;
    if (sl <= cursorLineNum && sl >= closestStart) {
      closestStart = sl;
      closestInst  = inst;
    }
  }

  // ── Bridge / Define ───────────────────────────────────────────────────
  if (closestInst.kind === "bridge" || closestInst.kind === "define") {
    // Handle alias in a with-declaration or wire
    const h = closestInst.handles.find(h => h.handle === word);
    if (h) {
      return { contents: { kind: MarkupKind.Markdown, value: handleBindingMarkdown(h) } };
    }

    // Bridge type / field name hover
    if (closestInst.kind === "bridge") {
      if (word === closestInst.type || word === closestInst.field) {
        const hc = closestInst.handles.length;
        const wc = closestInst.wires.length;
        return {
          contents: {
            kind:  MarkupKind.Markdown,
            value: `**Bridge** \`${closestInst.type}.${closestInst.field}\`\n\n${hc} handle${hc !== 1 ? "s" : ""} · ${wc} wire${wc !== 1 ? "s" : ""}`,
          },
        };
      }
    }

    if (closestInst.kind === "define" && word === closestInst.name) {
      return {
        contents: {
          kind:  MarkupKind.Markdown,
          value: `**Define** \`${closestInst.name}\`\n\nReusable subgraph (${closestInst.handles.length} handles · ${closestInst.wires.length} wires)`,
        },
      };
    }
  }

  // ── Tool ──────────────────────────────────────────────────────────────
  if (closestInst.kind === "tool") {
    // Dep handle alias
    const d = closestInst.deps.find(d => d.handle === word);
    if (d) {
      return { contents: { kind: MarkupKind.Markdown, value: toolDepMarkdown(d) } };
    }

    // Tool name / function name hover
    if (word === closestInst.name || word === closestInst.fn || word === closestInst.extends) {
      const fn  = closestInst.fn ?? `extends ${closestInst.extends}`;
      const dc  = closestInst.deps.length;
      const wc  = closestInst.wires.length;
      return {
        contents: {
          kind:  MarkupKind.Markdown,
          value: `**Tool** \`${closestInst.name}\`\n\nFunction: \`${fn}\`\n\n${dc} dep${dc !== 1 ? "s" : ""} · ${wc} wire${wc !== 1 ? "s" : ""}`,
        },
      };
    }
  }

  // ── Const ─────────────────────────────────────────────────────────────
  if (closestInst.kind === "const" && word === closestInst.name) {
    return {
      contents: {
        kind:  MarkupKind.Markdown,
        value: `**Const** \`${closestInst.name}\`\n\nValue: \`${closestInst.value}\``,
      },
    };
  }

  return null;
});

// ── Start ──────────────────────────────────────────────────────────────────

documents.listen(connection);
connection.listen();
