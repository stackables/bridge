/**
 * Bridge Language Server — provides LSP features for .bridge files.
 *
 * Runs as a standalone Node.js process spawned by the extension client.
 * Communicates via IPC using the Language Server Protocol.
 *
 * This file is a thin adapter: all intelligence logic lives in
 * `BridgeLanguageService` from @stackables/bridge. This server just
 * maps its output to the LSP wire format.
 *
 * Features:
 *   • Real-time diagnostics  (syntax errors + semantic validation)
 *   • Hover information      (handle bindings, bridge/tool declarations)
 *   • Autocomplete           (built-in std.* / math.* tool names)
 */
import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  type InitializeResult,
  TextDocumentSyncKind,
  DiagnosticSeverity,
  CompletionItemKind,
  MarkupKind,
  Range,
  TextEdit,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { BridgeLanguageService, parseBridgeCst, prettyPrintToSource } from "@stackables/bridge";
import type { CompletionKind } from "@stackables/bridge";

// ── Connection & document manager ──────────────────────────────────────────

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

/** One language-service instance per open document (keyed by URI). */
const services = new Map<string, BridgeLanguageService>();

function getService(uri: string): BridgeLanguageService {
  let svc = services.get(uri);
  if (!svc) {
    svc = new BridgeLanguageService();
    services.set(uri, svc);
  }
  return svc;
}

connection.onInitialize(
  (): InitializeResult => ({
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      hoverProvider: true,
      documentFormattingProvider: true,
      completionProvider: {
        triggerCharacters: ["."],
      },
    },
  }),
);

// ── Mapping helpers ────────────────────────────────────────────────────────

const completionKindMap: Record<CompletionKind, CompletionItemKind> = {
  function: CompletionItemKind.Function,
  variable: CompletionItemKind.Variable,
  keyword: CompletionItemKind.Keyword,
  type: CompletionItemKind.Class,
};

// ── Diagnostics ────────────────────────────────────────────────────────────

function validate(doc: TextDocument): void {
  const svc = getService(doc.uri);
  svc.update(doc.getText());

  const diags = svc.getDiagnostics();

  connection.sendDiagnostics({
    uri: doc.uri,
    diagnostics: diags.map((d) => ({
      severity:
        d.severity === "error"
          ? DiagnosticSeverity.Error
          : DiagnosticSeverity.Warning,
      range: d.range,
      message: d.message,
      source: "bridge",
    })),
  });
}

documents.onDidChangeContent((change) => validate(change.document));
documents.onDidOpen((e) => validate(e.document));
documents.onDidClose((e) => {
  services.delete(e.document.uri);
  connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
});

// ── Hover ──────────────────────────────────────────────────────────────────

connection.onHover((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;

  const svc = getService(doc.uri);
  svc.update(doc.getText());

  const hover = svc.getHover(params.position);
  if (!hover) return null;

  return {
    contents: { kind: MarkupKind.Markdown, value: hover.content },
    ...(hover.range ? { range: hover.range } : {}),
  };
});

// ── Completion ─────────────────────────────────────────────────────────────

connection.onCompletion((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];

  const svc = getService(doc.uri);
  svc.update(doc.getText());

  const completions = svc.getCompletions(params.position);

  return completions.map((c) => ({
    label: c.label,
    kind: completionKindMap[c.kind] ?? CompletionItemKind.Text,
    detail: c.detail,
    documentation: c.documentation,
  }));
});

connection.onDocumentFormatting((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;

  const text = doc.getText();

  try {
    parseBridgeCst(text);
  } catch (error) {
    connection.console.warn(
      `Bridge formatting aborted due to syntax errors: ${String((error as Error)?.message ?? error)}`,
    );
    return null;
  }

  const formatted = prettyPrintToSource(text, {
    tabSize: params.options.tabSize,
    insertSpaces: params.options.insertSpaces,
  });

  const range = Range.create(
    { line: 0, character: 0 },
    doc.positionAt(text.length),
  );

  return [TextEdit.replace(range, formatted)];
});

// ── Start ──────────────────────────────────────────────────────────────────

documents.listen(connection);
connection.listen();
