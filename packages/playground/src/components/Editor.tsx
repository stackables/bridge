import { useRef, useEffect, useCallback, useState } from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState, type Extension, Compartment } from "@codemirror/state";
import { diagnosticCount, lintGutter } from "@codemirror/lint";
import { json } from "@codemirror/lang-json";
import { graphql, graphqlLanguageSupport, updateSchema } from "cm6-graphql";
import type { GraphQLSchema } from "graphql";
import { bridgeLanguage } from "@/codemirror/bridge-lang";
import { bridgeLinter } from "@/codemirror/bridge-lint";
import { graphqlSchemaLinter } from "@/codemirror/graphql-schema-lint";
import { playgroundTheme } from "@/codemirror/theme";
import { cn } from "@/lib/utils";

/**
 * Language mode for the editor.
 *
 * - "bridge"        — Bridge DSL highlighting + inline linting
 * - "graphql"       — GraphQL SDL highlighting + inline schema linting
 * - "graphql-query" — GraphQL query editing with schema-aware autocomplete + linting (cm6-graphql)
 * - "json"          — JSON highlighting (context panel)
 * - "plain"         — no language support (fallback)
 */
export type EditorLanguage =
  | "bridge"
  | "graphql"
  | "graphql-query"
  | "json"
  | "plain";

type Props = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  language?: EditorLanguage;
  readOnly?: boolean;
  /** When true the editor sizes itself to its content instead of filling the parent. */
  autoHeight?: boolean;
  /** GraphQL schema for query editors — enables autocomplete & validation. */
  graphqlSchema?: GraphQLSchema;
};

function languageExtension(
  lang: EditorLanguage,
  graphqlSchema?: GraphQLSchema,
): Extension[] {
  switch (lang) {
    case "bridge":
      return [bridgeLanguage, bridgeLinter, lintGutter()];
    case "graphql":
      return [graphqlLanguageSupport(), graphqlSchemaLinter, lintGutter()];
    case "graphql-query":
      return [...graphql(graphqlSchema), lintGutter()];
    case "json":
      return [json()];
    case "plain":
      return [];
  }
}

export function Editor({
  label,
  value,
  onChange,
  language = "plain",
  readOnly = false,
  autoHeight = false,
  graphqlSchema,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [hasErrors, setHasErrors] = useState(false);

  // Stable dispatch listener — always calls the latest onChange + tracks lint errors
  const updateListener = useCallback(
    () =>
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          onChangeRef.current(update.state.doc.toString());
        }
        // Track lint diagnostic count for border styling
        const errorCount = diagnosticCount(update.state);
        setHasErrors(errorCount > 0);
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
        ...languageExtension(language, graphqlSchema),
        updateListener(),
        readOnlyCompartment.current.of([
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
        ]),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps — intentionally only on mount
  }, [language, updateListener]);

  // Push schema updates into the cm6-graphql extension for query editors
  useEffect(() => {
    const view = viewRef.current;
    if (!view || language !== "graphql-query") return;
    updateSchema(view, graphqlSchema);
  }, [graphqlSchema, language]);

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
    <div className={cn(!autoHeight && "flex flex-col h-full")}>
      {label && (
        <div className="shrink-0 pb-1.5 text-[11px] font-bold text-slate-600 uppercase tracking-widest">
          {label}
        </div>
      )}
      <div
        ref={containerRef}
        className={cn(
          "w-full rounded-lg border bg-slate-950 transition-colors",
          hasErrors
            ? "border-red-400/70"
            : "border-slate-800 focus-within:border-sky-400/70",
          autoHeight
            ? "[&_.cm-editor]:h-auto [&_.cm-scroller]:overflow-visible"
            : "flex-1 min-h-0 overflow-y-auto [&_.cm-editor]:h-full",
        )}
      />
    </div>
  );
}
