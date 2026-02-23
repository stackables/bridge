/**
 * CodeMirror 6 linter for GraphQL SDL (schema definitions).
 *
 * Runs `buildSchema` from graphql-js on every change (debounced) and maps
 * GraphQL syntax / validation errors to inline CodeMirror diagnostics.
 */
import { linter, type Diagnostic } from "@codemirror/lint";
import { buildSchema } from "graphql";
import type { EditorView } from "codemirror";

export const graphqlSchemaLinter = linter((view: EditorView): Diagnostic[] => {
  const text = view.state.doc.toString();
  if (!text.trim()) return [];

  try {
    buildSchema(text);
    return [];
  } catch (err: unknown) {
    if (!(err instanceof Error)) return [];

    // graphql-js errors carry `locations` with line/column info.
    const gqlErr = err as Error & {
      locations?: { line: number; column: number }[];
    };

    const loc = gqlErr.locations?.[0];
    if (!loc) {
      // No location — place the error on line 1
      return [{
        from: 0,
        to: Math.min(1, view.state.doc.length),
        severity: "error",
        message: gqlErr.message,
      }];
    }

    const line = Math.min(loc.line, view.state.doc.lines);
    const lineInfo = view.state.doc.line(line);
    const from = lineInfo.from + Math.min(Math.max(loc.column - 1, 0), lineInfo.length);
    let to = lineInfo.to;

    // Ensure at least one character is highlighted.
    if (to <= from) to = Math.min(from + 1, view.state.doc.length);

    return [{
      from,
      to,
      severity: "error",
      message: gqlErr.message,
    }];
  }
});
