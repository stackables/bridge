import { useRef, useEffect, useCallback } from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState, type Extension, Compartment } from "@codemirror/state";
import { json } from "@codemirror/lang-json";
import { bridgeLanguage } from "@/codemirror/bridge-lang";
import { graphqlLanguage } from "@/codemirror/graphql-lang";
import { playgroundTheme } from "@/codemirror/theme";

/**
 * Language mode for the editor.
 *
 * - "bridge"  — Bridge DSL highlighting via StreamLanguage tokenizer
 * - "graphql" — GraphQL schema/query highlighting via StreamLanguage tokenizer
 * - "json"    — JSON highlighting (context panel)
 * - "plain"   — no language support (fallback)
 */
export type EditorLanguage = "bridge" | "graphql" | "json" | "plain";

type Props = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  language?: EditorLanguage;
  readOnly?: boolean;
};

function languageExtension(lang: EditorLanguage): Extension[] {
  switch (lang) {
    case "bridge":  return [bridgeLanguage];
    case "graphql": return [graphqlLanguage];
    case "json":    return [json()];
    case "plain":   return [];
  }
}

export function Editor({ label, value, onChange, language = "plain", readOnly = false }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Stable dispatch listener — always calls the latest onChange
  const updateListener = useCallback(
    () =>
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          onChangeRef.current(update.state.doc.toString());
        }
      }),
    [],
  );

  // Compartment lets us toggle readOnly after creation (e.g. when result arrives)
  const readOnlyCompartment = useRef(new Compartment());

  // Create the editor once
  useEffect(() => {
    if (!containerRef.current) return;

    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        playgroundTheme,
        ...languageExtension(language),
        updateListener(),
        EditorView.lineWrapping,
        readOnlyCompartment.current.of([
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
        ]),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;

    return () => { view.destroy(); viewRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps — intentionally only on mount
  }, [language, updateListener]);

  // Sync external value changes (e.g. example picker) into the editor
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      });
    }
  }, [value]);

  return (
    <div className="flex flex-col h-full">
      {label && (
        <div className="shrink-0 pb-1.5 text-[11px] font-bold text-slate-600 uppercase tracking-widest">
          {label}
        </div>
      )}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 w-full rounded-lg border border-slate-800 bg-slate-950 overflow-y-auto [&_.cm-editor]:h-full"
      />
    </div>
  );
}


