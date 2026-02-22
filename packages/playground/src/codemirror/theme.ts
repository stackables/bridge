/**
 * Dark theme for CodeMirror that matches the playground's slate-950 palette.
 *
 * Token colours align with the Bridge TextMate scope names:
 *   keyword.control       → sky-400   (bridge, tool, with, const, define, …)
 *   entity.name.type      → emerald   (Query, Mutation)
 *   entity.name.function  → amber     (field names, define names)
 *   variable.other.handle → peach     (handles, aliases)
 *   variable              → slate-300 (general identifiers)
 *   keyword.operator      → pink      (<-, =, ||, ??, :)
 *   constant.language     → purple    (true, false, null, HTTP methods)
 *   constant.numeric      → orange
 *   string.*              → green
 *   comment               → slate-600
 */
import { EditorView } from "codemirror";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

const theme = EditorView.theme(
  {
    "&": {
      color: "#cbd5e1",           // slate-300
      backgroundColor: "transparent",
      fontSize: "13px",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    },
    ".cm-content": {
      caretColor: "#38bdf8",      // sky-400
      lineHeight: "1.625",
      padding: "8px 0",
    },
    "&.cm-focused .cm-cursor": { borderLeftColor: "#38bdf8" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
      backgroundColor: "#334155",  // slate-700
    },
    "&.cm-focused": { outline: "none" },
    ".cm-gutters": {
      backgroundColor: "transparent",
      borderRight: "none",
      color: "#475569",            // slate-600
    },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "#64748b" },
    ".cm-activeLine": { backgroundColor: "rgba(51, 65, 85, 0.3)" },
    ".cm-matchingBracket": {
      backgroundColor: "rgba(56, 189, 248, 0.15)",
      outline: "1px solid rgba(56, 189, 248, 0.3)",
    },
  },
  { dark: true },
);

const highlights = HighlightStyle.define([
  // Keywords: bridge, tool, with, const, define, version, as, from, on error
  { tag: tags.keyword,          color: "#38bdf8" },   // sky-400
  // Types: Query, Mutation
  { tag: tags.typeName,         color: "#34d399" },   // emerald-400
  // Definitions: field names, tool names, handle aliases
  { tag: tags.definition(tags.variableName), color: "#fbbf24" }, // amber-400
  // General variables / identifiers
  { tag: tags.variableName,     color: "#cbd5e1" },   // slate-300
  // Built-in handles: input, output, context
  { tag: tags.standard(tags.variableName), color: "#a78bfa" }, // violet-400
  // Properties: .baseUrl, .headers.Authorization
  { tag: tags.propertyName,     color: "#fdba74" },   // orange-300
  // Operators: <-, <-!, =, ||, ??, :
  { tag: tags.operator,         color: "#f472b6" },   // pink-400
  // Atoms: true, false, null, GET, POST, …
  { tag: tags.atom,             color: "#c084fc" },   // purple-400
  // Numbers
  { tag: tags.number,           color: "#fb923c" },   // orange-400
  // Strings
  { tag: tags.string,           color: "#4ade80" },   // green-400
  { tag: tags.special(tags.string), color: "#86efac" }, // green-300 (url paths)
  // Comments
  { tag: tags.comment,          color: "#475569" },   // slate-600
  // Brackets
  { tag: tags.bracket,          color: "#64748b" },   // slate-500
]);

export const playgroundTheme = [theme, syntaxHighlighting(highlights)];
