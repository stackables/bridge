import { RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import type { SourceLocation } from "@stackables/bridge";

function toOffsets(state: EditorView["state"], loc: SourceLocation) {
  if (state.doc.lines === 0) return null;

  const startLine = Math.min(Math.max(loc.startLine, 1), state.doc.lines);
  const endLine = Math.min(Math.max(loc.endLine, startLine), state.doc.lines);
  const startInfo = state.doc.line(startLine);
  const endInfo = state.doc.line(endLine);

  const from =
    startInfo.from +
    Math.min(Math.max(loc.startColumn - 1, 0), startInfo.length);
  let to = endInfo.from + Math.min(Math.max(loc.endColumn, 0), endInfo.length);

  if (to <= from) {
    to = Math.min(from + 1, state.doc.length);
  }

  if (to <= from) return null;
  return { from, to };
}

export function deadCodeRangesExtension(
  locations: SourceLocation[],
): Extension {
  if (locations.length === 0) return [];

  const mark = Decoration.mark({ class: "cm-dead-code-range" });

  return EditorView.decorations.compute([], (state) => {
    // Convert to offsets and sort by start position.
    const ranges: { from: number; to: number }[] = [];
    for (const location of locations) {
      const offsets = toOffsets(state, location);
      if (offsets) ranges.push(offsets);
    }
    ranges.sort((a, b) => a.from - b.from || a.to - b.to);

    // Merge overlapping ranges to prevent stacking decorations.
    const merged: { from: number; to: number }[] = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r.from <= last.to) {
        last.to = Math.max(last.to, r.to);
      } else {
        merged.push({ from: r.from, to: r.to });
      }
    }

    const builder = new RangeSetBuilder<Decoration>();
    for (const { from, to } of merged) {
      builder.add(from, to, mark);
    }
    return builder.finish();
  });
}
