/**
 * CodeMirror 6 linter extension for Bridge DSL.
 *
 * Thin adapter: gets diagnostics from BridgeLanguageService and maps
 * 0-based line/character ranges to CodeMirror absolute offsets.
 */
import { linter, type Diagnostic } from "@codemirror/lint";
import { BridgeLanguageService } from "@stackables/bridge";
import type { EditorView } from "codemirror";

const svc = new BridgeLanguageService();

export const bridgeLinter = linter((view: EditorView): Diagnostic[] => {
  const text = view.state.doc.toString();
  if (!text.trim()) return [];

  svc.update(text);

  return svc.getDiagnostics().flatMap((d) => {
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

    const from =
      startLineInfo.from +
      Math.min(Math.max(d.range.start.character, 0), startLineInfo.length);
    let to =
      endLineInfo.from +
      Math.min(
        Math.max(
          Number.isFinite(d.range.end.character) ? d.range.end.character : 0,
          0,
        ),
        endLineInfo.length,
      );

    // Ensure at least one character is highlighted so the underline is visible.
    if (to <= from) to = Math.min(from + 1, view.state.doc.length);

    return [
      {
        from,
        to,
        severity: d.severity === "error" ? "error" : "warning",
        message: d.message,
      },
    ];
  });
});
