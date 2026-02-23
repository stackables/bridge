/**
 * CodeMirror 6 linter extension for Bridge DSL.
 *
 * Runs `parseBridgeDiagnostics` on every document change (debounced) and
 * maps the results to CodeMirror inline diagnostics — squiggly underlines
 * with severity-coloured markers in the gutter.
 */
import { linter, type Diagnostic } from "@codemirror/lint";
import { parseBridgeDiagnostics } from "@stackables/bridge";
import type { EditorView } from "codemirror";

export const bridgeLinter = linter((view: EditorView): Diagnostic[] => {
  const text = view.state.doc.toString();
  if (!text.trim()) return [];

  const { diagnostics } = parseBridgeDiagnostics(text);

  return diagnostics.flatMap((d) => {
    // Guard against NaN / out-of-range positions from the parser.
    const rawStart = d.range.start.line;
    const rawEnd = d.range.end.line;
    if (!Number.isFinite(rawStart) || rawStart < 0) return [];

    const startLine = Math.min(rawStart + 1, view.state.doc.lines);
    const endLine = Math.min(
      Number.isFinite(rawEnd) && rawEnd >= 0 ? rawEnd + 1 : startLine,
      view.state.doc.lines,
    );
    const startLineInfo = view.state.doc.line(startLine);
    const endLineInfo = view.state.doc.line(endLine);

    const from = startLineInfo.from + Math.min(
      Math.max(d.range.start.character, 0),
      startLineInfo.length,
    );
    let to = endLineInfo.from + Math.min(
      Math.max(Number.isFinite(d.range.end.character) ? d.range.end.character : 0, 0),
      endLineInfo.length,
    );

    // Ensure at least one character is highlighted so the underline is visible.
    if (to <= from) to = Math.min(from + 1, view.state.doc.length);

    return [{
      from,
      to,
      severity: d.severity === "error" ? "error" : "warning",
      message: d.message,
    }];
  });
});
