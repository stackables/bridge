import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import {
  Panel,
  Group,
  Separator,
  useDefaultLayout,
} from "react-resizable-panels";
import { Editor } from "./components/Editor";
import { ResultView } from "./components/ResultView";
import { StandaloneQueryPanel } from "./components/StandaloneQueryPanel";
import { examples } from "./examples";
import {
  runBridge,
  runBridgeStandalone,
  getDiagnostics,
  extractBridgeOperations,
  extractOutputFields,
  extractInputSkeleton,
  mergeInputSkeleton,
  clearHttpCache,
  formatBridge,
} from "./engine";
import type { RunResult } from "./engine";
import { buildSchema, type GraphQLSchema } from "graphql";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { ShareDialog } from "./components/ShareDialog";
import {
  getShareIdFromUrl,
  loadShare,
  clearShareIdFromUrl,
  type PlaygroundMode,
} from "./share";
import { ChevronLeftIcon } from "lucide-react";

// ── resize handle — transparent hit area, no visual indicator ────────────────
function ResizeHandle({ direction }: { direction: "horizontal" | "vertical" }) {
  return (
    <Separator
      className={cn(
        "shrink-0 outline-none",
        direction === "horizontal"
          ? "w-2 cursor-[col-resize]"
          : "h-2 cursor-[row-resize]",
      )}
    />
  );
}

// ── query tab type ────────────────────────────────────────────────────────────
type QueryTab = {
  id: string;
  name: string;
  /** Whether the name was explicitly set by the user (disables auto-rename). */
  nameManual?: boolean;
  /** GraphQL query text (graphql mode). */
  query: string;
  /** Standalone mode fields — parallel to the graphql `query` field. */
  operation?: string;
  outputFields?: string;
  inputJson?: string;
};

// ── extract GraphQL operation name from query text ───────────────────────────
function extractOperationName(query: string): string | null {
  // Named operation: query/mutation/subscription OpName
  const named =
    /^\s*(?:query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)/m.exec(
      query,
    );
  if (named) return named[1]!;
  // Anonymous shorthand { fieldName ... } — use first root field
  const anon = /^\s*\{\s*([A-Za-z_][A-Za-z0-9_]*)/m.exec(query);
  if (anon) return anon[1]!;
  return null;
}

// ── query tab bar ─────────────────────────────────────────────────────────────
type QueryTabBarProps = {
  queries: QueryTab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onAddQuery: () => void;
  onRemoveQuery: (id: string) => void;
  onRenameQuery: (id: string, name: string) => void;
  onRun: () => void;
  runDisabled: boolean;
  running: boolean;
  showRunButton?: boolean;
};
function QueryTabBar({
  queries,
  activeTabId,
  onSelectTab,
  onAddQuery,
  onRemoveQuery,
  onRenameQuery,
  onRun,
  runDisabled,
  running,
  showRunButton = true,
}: QueryTabBarProps) {
  const isQueryTab = activeTabId !== "context";
  const canRemove = queries.length > 1;
  const [editingId, setEditingId] = useState<string | null>(null);
  const editRef = useRef<HTMLInputElement>(null);

  const commitRename = useCallback(
    (id: string) => {
      const val = editRef.current?.value.trim();
      if (val) onRenameQuery(id, val);
      setEditingId(null);
    },
    [onRenameQuery],
  );

  return (
    <div className="flex items-center shrink-0 gap-px overflow-x-auto scrollbar-none">
      {/* Context tab — always first */}
      <button
        onClick={() => onSelectTab("context")}
        className={cn(
          "shrink-0 uppercase px-3.5 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors whitespace-nowrap",
          activeTabId === "context"
            ? "border-sky-400 text-slate-200"
            : "border-transparent text-slate-500 hover:text-slate-300",
        )}
      >
        Context
      </button>

      {/* One tab per query */}
      {queries.map((q) => (
        <div
          key={q.id}
          className={cn(
            "group shrink-0 flex items-center border-b-2 -mb-px transition-colors",
            activeTabId === q.id
              ? "border-sky-400 text-slate-200"
              : "border-transparent text-slate-500 hover:text-slate-300",
          )}
        >
          {editingId === q.id ? (
            <input
              ref={editRef}
              defaultValue={q.name}
              autoFocus
              className="uppercase px-2 py-0.5 mx-1.5 text-xs font-medium bg-slate-900 border border-sky-400 rounded text-slate-200 outline-none w-28"
              onBlur={() => commitRename(q.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename(q.id);
                if (e.key === "Escape") setEditingId(null);
              }}
            />
          ) : (
            <button
              onClick={() => onSelectTab(q.id)}
              onDoubleClick={() => {
                setEditingId(q.id);
                onSelectTab(q.id);
              }}
              className="uppercase px-3.5 py-1.5 text-xs font-medium whitespace-nowrap"
              title="Double-click to rename"
            >
              {q.name}
            </button>
          )}
          {canRemove && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRemoveQuery(q.id);
              }}
              className="pr-2 -ml-1.5 text-slate-600 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
              title={`Close ${q.name}`}
            >
              <svg
                className="w-3 h-3"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.5}
                strokeLinecap="round"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
      ))}

      {/* Add query button */}
      <button
        onClick={onAddQuery}
        className="shrink-0 px-2 py-1.5 text-slate-600 hover:text-slate-300 transition-colors -mb-px border-b-2 border-transparent"
        title="Add query"
      >
        <svg
          className="w-3.5 h-3.5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
        >
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>

      <div className="flex-1" />

      {/* Run button — visible only when a query tab is active */}
      {showRunButton && isQueryTab && (
        <Button
          size="sm"
          onClick={onRun}
          disabled={runDisabled}
          className="shrink-0 text-xs h-7 px-3"
        >
          {running ? "Running…" : "▶  Run"}
        </Button>
      )}
    </div>
  );
}

// ── bridge DSL panel header (label only) ─────────────────────────────────────
function BridgeDslHeader() {
  return (
    <div className="content-center shrink-0 px-5 h-10 flex items-center">
      <span className="text-[11px] font-bold text-slate-200 uppercase tracking-widest">
        Bridge DSL
      </span>
    </div>
  );
}

// ── schema panel header with mode toggle ─────────────────────────────────────
function SchemaHeader({
  mode,
  onModeChange,
}: {
  mode: PlaygroundMode;
  onModeChange: (m: PlaygroundMode) => void;
}) {
  return (
    <div className="content-center shrink-0 px-5 h-10 pt-1.5 pb-1.5 flex items-center justify-between">
      <span className="text-[11px] font-bold text-slate-200 uppercase tracking-widest">
        GraphQL Schema
      </span>
      <button
        onClick={() =>
          onModeChange(mode === "graphql" ? "standalone" : "graphql")
        }
        className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-slate-500 hover:text-slate-300 transition-colors"
        title={
          mode === "graphql"
            ? "Switch to standalone mode (no GraphQL)"
            : "Switch to GraphQL mode"
        }
      >
        <span className={mode === "graphql" ? "text-sky-400" : ""}>GQL</span>
        <span className="relative inline-flex h-4 w-7 items-center rounded-full border border-slate-600 bg-slate-900 transition-colors">
          <span
            className={cn(
              "inline-block h-2.5 w-2.5 rounded-full bg-sky-400 transition-transform",
              mode === "standalone" ? "translate-x-3.5" : "translate-x-0.5",
            )}
          />
        </span>
        <span className={mode === "standalone" ? "text-sky-400" : ""}>CLI</span>
      </button>
    </div>
  );
}

// ── panel wrapper ─────────────────────────────────────────────────────────────
function PanelBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-slate-800 rounded-xl flex flex-col overflow-hidden h-full">
      {children}
    </div>
  );
}

// ── panel header label ─────────────────────────────────────────────────────────
function PanelLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="content-center shrink-0 px-5 h-10 pt-1.5 pb-1.5 text-[11px] font-bold text-slate-200 uppercase tracking-widest">
      {children}
    </div>
  );
}

// ── main ──────────────────────────────────────────────────────────────────────
export function App() {
  const [exampleIndex, setExampleIndex] = useState(0);
  const ex = examples[exampleIndex] ?? examples[0]!;

  const [mode, setMode] = useState<PlaygroundMode>(ex.mode ?? "standalone");
  const [schema, setSchema] = useState(ex.schema);
  const [bridge, setBridge] = useState(ex.bridge);
  const [context, setContext] = useState(ex.context);

  // ── persisted panel layouts ──
  const hLayout = useDefaultLayout({ id: "bridge-playground-h" });
  const leftVLayout = useDefaultLayout({ id: "bridge-playground-left-v" });
  const rightVLayout = useDefaultLayout({ id: "bridge-playground-right-v" });

  // ── multi-query state ──
  const queryCounterRef = useRef(ex.queries.length);

  function buildQueryTabs(e: (typeof examples)[number]): QueryTab[] {
    return e.queries.map((q, i) => {
      const sq = e.standaloneQueries?.[i];
      return {
        id: crypto.randomUUID(),
        name: q.name,
        nameManual: true,
        query: q.query,
        operation: sq?.operation ?? "",
        outputFields: sq?.outputFields ?? "",
        inputJson: sq ? JSON.stringify(sq.input, null, 2) : "{}",
      };
    });
  }

  const [queries, setQueries] = useState<QueryTab[]>(() => buildQueryTabs(ex));
  const [activeTabId, setActiveTabId] = useState<string>(
    () => queries[0]?.id ?? "context",
  );
  const [results, setResults] = useState<Record<string, RunResult>>({});
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());

  // Track the last active query so the result panel keeps showing when context tab is open
  const lastQueryIdRef = useRef(queries[0]?.id);
  if (activeTabId !== "context") lastQueryIdRef.current = activeTabId;
  const displayQueryId =
    activeTabId !== "context" ? activeTabId : lastQueryIdRef.current;
  const displayResult = displayQueryId
    ? (results[displayQueryId] ?? null)
    : null;
  const displayRunning = displayQueryId
    ? runningIds.has(displayQueryId)
    : false;

  const activeQuery = queries.find((q) => q.id === activeTabId);

  // Load shared playground state from ?s=<id> on first mount
  useEffect(() => {
    const id = getShareIdFromUrl();
    if (!id) return;
    clearShareIdFromUrl();
    loadShare(id)
      .then((payload) => {
        setMode(payload.mode ?? "standalone");
        setSchema(payload.schema);
        setBridge(payload.bridge);
        queryCounterRef.current = payload.queries.length;
        const newQ: QueryTab[] = payload.queries.map((q, i) => {
          const sq = payload.standaloneQueries?.[i];
          return {
            id: crypto.randomUUID(),
            name: q.name,
            nameManual: true,
            query: q.query,
            operation: sq?.operation ?? "",
            outputFields: sq?.outputFields ?? "",
            inputJson: sq?.inputJson ?? "{}",
          };
        });
        setQueries(newQ);
        setContext(payload.context);
        setResults({});
        setRunningIds(new Set());
        setActiveTabId(newQ[0]?.id ?? "context");
      })
      .catch(() => {
        // silently ignore — invalid/expired share id
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const selectExample = useCallback((index: number) => {
    const e = examples[index] ?? examples[0]!;
    setExampleIndex(index);
    if (e.mode) setMode(e.mode);
    setSchema(e.schema);
    setBridge(e.bridge);
    queryCounterRef.current = e.queries.length;
    const newQ = buildQueryTabs(e);
    setQueries(newQ);
    setContext(e.context);
    setResults({});
    setRunningIds(new Set());
    setActiveTabId(newQ[0]?.id ?? "context");
  }, []);

  const updateQuery = useCallback((id: string, text: string) => {
    setQueries((prev) =>
      prev.map((q) => {
        if (q.id !== id) return q;
        // Only auto-rename from GQL operation name if the user hasn't manually renamed
        if (!q.nameManual) {
          const opName = extractOperationName(text);
          if (opName) return { ...q, query: text, name: opName };
        }
        return { ...q, query: text };
      }),
    );
  }, []);

  const addQuery = useCallback(() => {
    queryCounterRef.current += 1;
    const tab: QueryTab = {
      id: crypto.randomUUID(),
      name: `Query ${queryCounterRef.current}`,
      query: "",
      operation: "",
      outputFields: "",
      inputJson: "{}",
    };
    setQueries((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
  }, []);

  const removeQuery = useCallback(
    (id: string) => {
      setQueries((prev) => {
        if (prev.length <= 1) return prev;
        const idx = prev.findIndex((q) => q.id === id);
        const next = prev.filter((q) => q.id !== id);
        if (activeTabId === id) {
          const fallback =
            next[Math.min(idx, next.length - 1)]?.id ?? "context";
          setActiveTabId(fallback);
        }
        return next;
      });
      setResults((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    },
    [activeTabId],
  );

  const renameQuery = useCallback((id: string, name: string) => {
    setQueries((prev) =>
      prev.map((q) => (q.id === id ? { ...q, name, nameManual: true } : q)),
    );
  }, []);

  const updateStandaloneField = useCallback(
    (
      id: string,
      field: "operation" | "outputFields" | "inputJson",
      value: string,
    ) => {
      setQueries((prev) =>
        prev.map((q) => {
          if (q.id !== id) return q;
          const updated = { ...q, [field]: value };
          // When changing operation, auto-fill input skeleton if input is default
          if (field === "operation" && (!q.inputJson || q.inputJson === "{}")) {
            updated.inputJson = extractInputSkeleton(bridge, value);
          }
          return updated;
        }),
      );
    },
    [bridge],
  );

  const handleRun = useCallback(async () => {
    if (!activeQuery) return;
    const qId = activeQuery.id;
    setRunningIds((prev) => new Set(prev).add(qId));
    try {
      let r: RunResult;
      if (mode === "standalone") {
        r = await runBridgeStandalone(
          bridge,
          activeQuery.operation ?? "",
          activeQuery.inputJson ?? "{}",
          activeQuery.outputFields ?? "",
          context,
        );
      } else {
        r = await runBridge(schema, bridge, activeQuery.query, {}, context);
      }
      setResults((prev) => ({ ...prev, [qId]: r }));
    } finally {
      setRunningIds((prev) => {
        const next = new Set(prev);
        next.delete(qId);
        return next;
      });
    }
  }, [activeQuery, mode, schema, bridge, context]);

  const handleFormatBridge = useCallback(() => {
    const formatted = formatBridge(bridge);
    setBridge(formatted);
  }, [bridge]);

  const diagnostics = getDiagnostics(bridge).diagnostics;
  const hasErrors = diagnostics.some((d) => d.severity === "error");
  const isActiveRunning =
    activeTabId !== "context" && runningIds.has(activeTabId);

  // Build the GraphQL schema object for the query editor (autocomplete + linting).
  // Returns undefined when the SDL is invalid so the query editor still works.
  const graphqlSchema = useMemo<GraphQLSchema | undefined>(() => {
    try {
      return buildSchema(schema);
    } catch {
      return undefined;
    }
  }, [schema]);

  // Extract bridge operations for standalone mode's bridge selector
  const bridgeOperations = useMemo(
    () => extractBridgeOperations(bridge),
    [bridge],
  );

  // Auto-select first operation when the list changes and current selection is invalid
  useEffect(() => {
    if (mode !== "standalone" || bridgeOperations.length === 0) return;
    setQueries((prev) =>
      prev.map((q) => {
        if (
          q.operation &&
          bridgeOperations.some((op) => op.label === q.operation)
        )
          return q;
        return { ...q, operation: bridgeOperations[0]!.label };
      }),
    );
  }, [bridgeOperations, mode]);

  // Handle mode change: when switching to "standalone", auto-fill operation
  // and input JSON skeleton for tabs that don't already have them.
  const handleModeChange = useCallback(
    (newMode: PlaygroundMode) => {
      setMode(newMode);
      if (newMode === "standalone") {
        const ops = extractBridgeOperations(bridge);
        const firstOp = ops[0]?.label ?? "";
        setQueries((prev) =>
          prev.map((q) => {
            const op =
              q.operation && ops.some((o) => o.label === q.operation)
                ? q.operation
                : firstOp;
            const inputJson =
              !q.inputJson || q.inputJson === "{}"
                ? extractInputSkeleton(bridge, op)
                : q.inputJson;
            return { ...q, operation: op, inputJson };
          }),
        );
      }
    },
    [bridge],
  );

  // Extract all possible output field paths for the active standalone operation
  const activeOperation = activeQuery?.operation ?? "";
  const availableOutputFields = useMemo(
    () => extractOutputFields(bridge, activeOperation),
    [bridge, activeOperation],
  );

  // When the bridge DSL changes in standalone mode, merge new input fields
  // into each tab's inputJson (adds new fields, preserves user values).
  // Also prune outputFields that no longer exist in the bridge.
  const prevBridgeRef = useRef(bridge);
  useEffect(() => {
    if (prevBridgeRef.current === bridge) return;
    prevBridgeRef.current = bridge;
    if (mode !== "standalone") return;

    setQueries((prev) =>
      prev.map((q) => {
        const op = q.operation ?? "";
        if (!op) return q;

        // Merge new input fields into existing JSON
        const skeleton = extractInputSkeleton(bridge, op);
        const mergedInput = mergeInputSkeleton(q.inputJson ?? "{}", skeleton);

        // Prune selected output fields that no longer exist
        const currentFields = extractOutputFields(bridge, op);
        const validPaths = new Set(currentFields.map((f) => f.path));
        const selectedFields = (q.outputFields ?? "")
          .split(",")
          .map((f) => f.trim())
          .filter((f) => f && validPaths.has(f));

        return {
          ...q,
          inputJson: mergedInput,
          outputFields: selectedFields.join(","),
        };
      }),
    );
  }, [bridge, mode]);

  const isStandalone = mode === "standalone";

  return (
    <div className="md:h-screen bg-slate-950 text-slate-200 font-sans flex flex-col overflow-hidden">
      {/* ── Header ── */}
      <header className="shrink-0 border-b border-slate-800">
        {/* Row 1: logo + (desktop: example picker + info) + share */}
        <div className="px-4 py-2 flex items-center gap-3 md:px-5 md:py-2.5 md:gap-4">
          <a href="/" className="flex items-center gap-2.5 no-underline">
            <span className="text-xl font-bold text-sky-400 tracking-tight flex items-center">
              <ChevronLeftIcon /> Documentation
            </span>
          </a>

          {/* Example picker — desktop only (row 1) */}
          <div className="hidden md:flex items-center gap-2">
            <span className="text-xs text-slate-600">Example:</span>
            <Select
              value={String(exampleIndex)}
              onValueChange={(v) => selectExample(Number(v))}
            >
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {examples.map((ex, i) => (
                  <SelectItem key={i} value={String(i)}>
                    {ex.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="ml-auto flex items-center gap-2 md:gap-3">
            <span className="hidden md:block text-xs text-slate-700">
              All code runs in-browser · no server required
            </span>
            <ShareDialog
              mode={mode}
              schema={schema}
              bridge={bridge}
              queries={queries.map((q) => ({ name: q.name, query: q.query }))}
              context={context}
              standaloneQueries={
                isStandalone
                  ? queries.map((q) => ({
                      operation: q.operation ?? "",
                      outputFields: q.outputFields ?? "",
                      inputJson: q.inputJson ?? "{}",
                    }))
                  : undefined
              }
            />
          </div>
        </div>

        {/* Row 2: example picker — mobile only */}
        <div className="md:hidden px-4 pb-2 flex items-center gap-2">
          <span className="text-xs text-slate-600">Example:</span>
          <Select
            value={String(exampleIndex)}
            onValueChange={(v) => selectExample(Number(v))}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {examples.map((ex, i) => (
                <SelectItem key={i} value={String(i)}>
                  {ex.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </header>

      {/* ── Mobile layout: vertical scrollable stack ── */}
      <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-3 md:hidden">
        {/* Schema panel — hidden in standalone mode, shows mode toggle */}
        {!isStandalone ? (
          <div className="bg-slate-800 rounded-xl flex flex-col overflow-hidden">
            <SchemaHeader mode={mode} onModeChange={handleModeChange} />
            <div className="px-3 pb-3">
              <Editor
                label=""
                value={schema}
                onChange={setSchema}
                language="graphql"
                autoHeight
              />
            </div>
          </div>
        ) : (
          /* When in standalone, show a collapsed "GraphQL Schema" bar with the toggle */
          <div className="bg-slate-800 rounded-xl flex flex-col overflow-hidden">
            <SchemaHeader mode={mode} onModeChange={handleModeChange} />
          </div>
        )}

        {/* Bridge DSL panel */}
        <div className="bg-slate-800 rounded-xl flex flex-col overflow-hidden">
          <BridgeDslHeader />
          <div className="px-3 pb-3">
            <Editor
              label=""
              value={bridge}
              onChange={setBridge}
              language="bridge"
              autoHeight
              onFormat={handleFormatBridge}
            />
          </div>
        </div>

        {/* Query / Context panel */}
        <div className="bg-slate-800 rounded-xl flex flex-col overflow-hidden">
          <div className="shrink-0 px-5 pt-1.5">
            <QueryTabBar
              queries={queries}
              activeTabId={activeTabId}
              onSelectTab={setActiveTabId}
              onAddQuery={addQuery}
              onRemoveQuery={removeQuery}
              onRenameQuery={renameQuery}
              onRun={handleRun}
              runDisabled={isActiveRunning || hasErrors}
              running={isActiveRunning}
              showRunButton={false}
            />
          </div>
          <div className="p-3 pt-2">
            {activeTabId === "context" ? (
              <Editor
                label=""
                value={context}
                onChange={setContext}
                language="json"
                autoHeight
              />
            ) : activeQuery ? (
              isStandalone ? (
                <StandaloneQueryPanel
                  operations={bridgeOperations}
                  operation={activeQuery.operation ?? ""}
                  onOperationChange={(v) =>
                    updateStandaloneField(activeTabId, "operation", v)
                  }
                  availableFields={availableOutputFields}
                  outputFields={activeQuery.outputFields ?? ""}
                  onOutputFieldsChange={(v) =>
                    updateStandaloneField(activeTabId, "outputFields", v)
                  }
                  inputJson={activeQuery.inputJson ?? "{}"}
                  onInputJsonChange={(v) =>
                    updateStandaloneField(activeTabId, "inputJson", v)
                  }
                  autoHeight
                />
              ) : (
                <Editor
                  key={activeTabId}
                  label=""
                  value={activeQuery.query}
                  onChange={(v) => updateQuery(activeTabId, v)}
                  language="graphql-query"
                  graphqlSchema={graphqlSchema}
                  autoHeight
                />
              )
            ) : null}
          </div>
        </div>

        {/* Run button — full-width below query panel, mobile only */}
        {activeTabId !== "context" && (
          <Button
            onClick={handleRun}
            disabled={isActiveRunning || hasErrors}
            className="w-full"
          >
            {isActiveRunning ? "Running…" : "▶  Run"}
          </Button>
        )}

        {/* Result panel */}
        <div className="bg-slate-800 rounded-xl flex flex-col overflow-hidden">
          <PanelLabel>Result</PanelLabel>
          <div className="px-3.5 pb-3.5 flex flex-col">
            <ResultView
              result={displayResult?.data}
              errors={displayResult?.errors}
              loading={displayRunning}
              traces={displayResult?.traces}
              logs={displayResult?.logs}
              onClearCache={clearHttpCache}
              autoHeight
            />
          </div>
        </div>
      </div>

      {/* ── Desktop layout: resizable panels ── */}
      <div className="flex-1 min-h-0 p-3 overflow-hidden hidden md:block">
        <Group
          orientation="horizontal"
          className="h-full"
          defaultLayout={hLayout.defaultLayout}
          onLayoutChanged={hLayout.onLayoutChanged}
        >
          {/* ── LEFT column: Schema + Bridge (or Bridge only) ── */}
          <Panel defaultSize={50} minSize={20}>
            {isStandalone ? (
              /* Standalone: collapsed schema header + bridge fills left column */
              <div className="flex flex-col h-full gap-2">
                <div className="shrink-0 bg-slate-800 rounded-xl overflow-hidden">
                  <SchemaHeader mode={mode} onModeChange={handleModeChange} />
                </div>
                <PanelBox>
                  <BridgeDslHeader />
                  <div className="flex-1 min-h-0 px-3 pb-3">
                    <Editor
                      label=""
                      value={bridge}
                      onChange={setBridge}
                      language="bridge"
                      onFormat={handleFormatBridge}
                    />
                  </div>
                </PanelBox>
              </div>
            ) : (
              /* GraphQL mode: schema + bridge in a vertical split */
              <Group
                orientation="vertical"
                className="h-full"
                defaultLayout={leftVLayout.defaultLayout}
                onLayoutChanged={leftVLayout.onLayoutChanged}
              >
                {/* Schema panel */}
                <Panel defaultSize={35} minSize={15}>
                  <PanelBox>
                    <SchemaHeader mode={mode} onModeChange={handleModeChange} />
                    <div className="flex-1 min-h-0 px-3 pb-3">
                      <Editor
                        label=""
                        value={schema}
                        onChange={setSchema}
                        language="graphql"
                      />
                    </div>
                  </PanelBox>
                </Panel>

                <ResizeHandle direction="vertical" />

                {/* Bridge DSL panel */}
                <Panel defaultSize={65} minSize={20}>
                  <PanelBox>
                    <BridgeDslHeader />
                    <div className="flex-1 min-h-0 px-3 pb-3">
                      <Editor
                        label=""
                        value={bridge}
                        onChange={setBridge}
                        language="bridge"
                        onFormat={handleFormatBridge}
                      />
                    </div>
                  </PanelBox>
                </Panel>
              </Group>
            )}
          </Panel>

          <ResizeHandle direction="horizontal" />

          {/* ── RIGHT column: Query/Context + Results ── */}
          <Panel defaultSize={50} minSize={20}>
            <Group
              orientation="vertical"
              className="h-full"
              defaultLayout={rightVLayout.defaultLayout}
              onLayoutChanged={rightVLayout.onLayoutChanged}
            >
              {/* Query / Context tabbed panel */}
              <Panel defaultSize={40} minSize={15}>
                <PanelBox>
                  <PanelLabel>
                    <QueryTabBar
                      queries={queries}
                      activeTabId={activeTabId}
                      onSelectTab={setActiveTabId}
                      onAddQuery={addQuery}
                      onRemoveQuery={removeQuery}
                      onRenameQuery={renameQuery}
                      onRun={handleRun}
                      runDisabled={isActiveRunning || hasErrors}
                      running={isActiveRunning}
                    />
                  </PanelLabel>

                  <div className="flex-1 min-h-0 p-3 pt-0">
                    {activeTabId === "context" ? (
                      <Editor
                        label=""
                        value={context}
                        onChange={setContext}
                        language="json"
                      />
                    ) : activeQuery ? (
                      isStandalone ? (
                        <StandaloneQueryPanel
                          operations={bridgeOperations}
                          operation={activeQuery.operation ?? ""}
                          onOperationChange={(v) =>
                            updateStandaloneField(activeTabId, "operation", v)
                          }
                          availableFields={availableOutputFields}
                          outputFields={activeQuery.outputFields ?? ""}
                          onOutputFieldsChange={(v) =>
                            updateStandaloneField(
                              activeTabId,
                              "outputFields",
                              v,
                            )
                          }
                          inputJson={activeQuery.inputJson ?? "{}"}
                          onInputJsonChange={(v) =>
                            updateStandaloneField(activeTabId, "inputJson", v)
                          }
                        />
                      ) : (
                        <Editor
                          key={activeTabId}
                          label=""
                          value={activeQuery.query}
                          onChange={(v) => updateQuery(activeTabId, v)}
                          language="graphql-query"
                          graphqlSchema={graphqlSchema}
                        />
                      )
                    ) : null}
                  </div>
                </PanelBox>
              </Panel>

              <ResizeHandle direction="vertical" />

              {/* Result panel */}
              <Panel defaultSize={60} minSize={20}>
                <PanelBox>
                  <PanelLabel>Result</PanelLabel>
                  <div className="flex-1 min-h-0 px-3.5 pb-3.5 overflow-hidden flex flex-col">
                    <ResultView
                      result={displayResult?.data}
                      errors={displayResult?.errors}
                      loading={displayRunning}
                      traces={displayResult?.traces}
                      logs={displayResult?.logs}
                      onClearCache={clearHttpCache}
                    />
                  </div>
                </PanelBox>
              </Panel>
            </Group>
          </Panel>
        </Group>
      </div>
    </div>
  );
}
