/**
 * CodeMirror 6 autocomplete extension for the Bridge DSL.
 *
 * Thin adapter: gets completions from BridgeLanguageService and maps
 * them to CodeMirror's autocomplete format.
 */
import {
  autocompletion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { BridgeLanguageService } from "@stackables/bridge";
import type { CompletionKind } from "@stackables/bridge";

const svc = new BridgeLanguageService();

/** Map BridgeLanguageService completion kinds → CodeMirror types */
const kindMap: Record<CompletionKind, string> = {
  function: "function",
  variable: "variable",
  keyword: "keyword",
  type: "type",
};

function bridgeCompletions(ctx: CompletionContext): CompletionResult | null {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const lineNum = line.number - 1; // 0-based for the language service
  const character = ctx.pos - line.from;

  svc.update(ctx.state.doc.toString());
  const completions = svc.getCompletions({ line: lineNum, character });
  if (completions.length === 0) return null;

  // Calculate how much of the current partial token to replace.
  // nsDotMatch handles deep std paths like "std.", "std.arr.", "std.arr.fi"
  // and captures only the last (partial) segment after the final dot.
  const textBefore = line.text.slice(0, character);
  const nsDotMatch = textBefore.match(/\bstd(?:\.\w+)*\.(\w*)$/);
  const contextMatch = textBefore.match(
    /(?:^\s*with\s+|(?:from|extends)\s+)(\S*)$/,
  );
  const partial = nsDotMatch?.[1] ?? contextMatch?.[1] ?? "";

  return {
    from: ctx.pos - partial.length,
    // Keep completions valid while user types more word chars after the dot
    validFor: /^\w*$/,
    options: completions.map((c) => ({
      label: c.label,
      type: kindMap[c.kind] ?? "text",
      detail: c.detail,
    })),
  };
}

export const bridgeAutocomplete = autocompletion({
  override: [bridgeCompletions],
});
