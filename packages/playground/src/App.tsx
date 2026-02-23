import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Editor } from "./components/Editor";
import { ResultView } from "./components/ResultView";
import { examples } from "./examples";
import { runBridge, getDiagnostics } from "./engine";
import type { RunResult } from "./engine";
import { buildSchema, type GraphQLSchema } from "graphql";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { ShareDialog } from "./components/ShareDialog";
import { getShareIdFromUrl, loadShare, clearShareIdFromUrl } from "./share";

// ── resize handle — transparent hit area, no visual indicator ────────────────
function ResizeHandle({ direction }: { direction: "horizontal" | "vertical" }) {
  return (
    <PanelResizeHandle
      className={cn(
        "shrink-0",
        direction === "horizontal"
          ? "w-2 cursor-[col-resize]"
          : "h-2 cursor-[row-resize]",
      )}
    />
  );
}

// ── query tab type ────────────────────────────────────────────────────────────
type QueryTab = { id: string; name: string; query: string };

// ── query tab bar ─────────────────────────────────────────────────────────────
type QueryTabBarProps = {
  queries: QueryTab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onAddQuery: () => void;
  onRemoveQuery: (id: string) => void;
  onRun: () => void;
  runDisabled: boolean;
  running: boolean;
};
function QueryTabBar({
  queries,
  activeTabId,
  onSelectTab,
  onAddQuery,
  onRemoveQuery,
  onRun,
  runDisabled,
  running,
}: QueryTabBarProps) {
  const isQueryTab = activeTabId !== "context";
  const canRemove = queries.length > 1;
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
          <button
            onClick={() => onSelectTab(q.id)}
            className="uppercase px-3.5 py-1.5 text-xs font-medium whitespace-nowrap"
          >
            {q.name}
          </button>
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
      {isQueryTab && (
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

  const [schema, setSchema] = useState(ex.schema);
  const [bridge, setBridge] = useState(ex.bridge);
  const [context, setContext] = useState(ex.context);

  // ── multi-query state ──
  const queryCounterRef = useRef(ex.queries.length);
  const [queries, setQueries] = useState<QueryTab[]>(() =>
    ex.queries.map((q) => ({
      id: crypto.randomUUID(),
      name: q.name,
      query: q.query,
    })),
  );
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
        setSchema(payload.schema);
        setBridge(payload.bridge);
        queryCounterRef.current = payload.queries.length;
        const newQ = payload.queries.map((q) => ({
          id: crypto.randomUUID(),
          name: q.name,
          query: q.query,
        }));
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
    setSchema(e.schema);
    setBridge(e.bridge);
    queryCounterRef.current = e.queries.length;
    const newQ = e.queries.map((q) => ({
      id: crypto.randomUUID(),
      name: q.name,
      query: q.query,
    }));
    setQueries(newQ);
    setContext(e.context);
    setResults({});
    setRunningIds(new Set());
    setActiveTabId(newQ[0]?.id ?? "context");
  }, []);

  const updateQuery = useCallback((id: string, text: string) => {
    setQueries((prev) =>
      prev.map((q) => (q.id === id ? { ...q, query: text } : q)),
    );
  }, []);

  const addQuery = useCallback(() => {
    queryCounterRef.current += 1;
    const tab: QueryTab = {
      id: crypto.randomUUID(),
      name: `Query ${queryCounterRef.current}`,
      query: "",
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

  const handleRun = useCallback(async () => {
    if (!activeQuery) return;
    const qId = activeQuery.id;
    const qText = activeQuery.query;
    setRunningIds((prev) => new Set(prev).add(qId));
    try {
      const r = await runBridge(schema, bridge, qText, {}, context);
      setResults((prev) => ({ ...prev, [qId]: r }));
    } finally {
      setRunningIds((prev) => {
        const next = new Set(prev);
        next.delete(qId);
        return next;
      });
    }
  }, [activeQuery, schema, bridge, context]);

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

  return (
    <div className="md:h-screen bg-slate-950 text-slate-200 font-sans flex flex-col overflow-hidden">
      {/* ── Header ── */}
      <header className="shrink-0 border-b border-slate-800">
        {/* Row 1: logo + (desktop: example picker + info) + share */}
        <div className="px-4 py-2 flex items-center gap-3 md:px-5 md:py-2.5 md:gap-4">
          <a
            href="https://github.com/stackables/bridge"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2.5 no-underline"
          >
            <span className="text-xl font-bold text-sky-400 tracking-tight">
              Bridge
            </span>
            <Badge className="text-[10px] tracking-wider uppercase">
              Playground
            </Badge>
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
              schema={schema}
              bridge={bridge}
              queries={queries.map((q) => ({ name: q.name, query: q.query }))}
              context={context}
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
        {/* Schema panel */}
        <div className="bg-slate-800 rounded-xl flex flex-col overflow-hidden">
          <PanelLabel>GraphQL Schema</PanelLabel>
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

        {/* Bridge DSL panel */}
        <div className="bg-slate-800 rounded-xl flex flex-col overflow-hidden">
          <PanelLabel>Bridge DSL</PanelLabel>
          <div className="px-3 pb-3">
            <Editor
              label=""
              value={bridge}
              onChange={setBridge}
              language="bridge"
              autoHeight
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
              onRun={handleRun}
              runDisabled={isActiveRunning || hasErrors}
              running={isActiveRunning}
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
              <Editor
                key={activeTabId}
                label=""
                value={activeQuery.query}
                onChange={(v) => updateQuery(activeTabId, v)}
                language="graphql-query"
                graphqlSchema={graphqlSchema}
                autoHeight
              />
            ) : null}
          </div>
        </div>

        {/* Result panel */}
        <div className="bg-slate-800 rounded-xl flex flex-col overflow-hidden">
          <PanelLabel>Result</PanelLabel>
          <div className="px-3.5 pb-3.5 flex flex-col">
            <ResultView
              result={displayResult?.data}
              errors={displayResult?.errors}
              loading={displayRunning}
              traces={displayResult?.traces}
              autoHeight
            />
          </div>
        </div>
      </div>

      {/* ── Desktop layout: resizable panels ── */}
      <div className="flex-1 min-h-0 p-3 overflow-hidden hidden md:block">
        <PanelGroup
          direction="horizontal"
          autoSaveId="bridge-playground-h"
          className="h-full"
        >
          {/* ── LEFT column: Schema + Bridge ── */}
          <Panel defaultSize={50} minSize={20}>
            <PanelGroup
              direction="vertical"
              autoSaveId="bridge-playground-left-v"
              className="h-full"
            >
              {/* Schema panel */}
              <Panel defaultSize={35} minSize={15}>
                <PanelBox>
                  <PanelLabel>GraphQL Schema</PanelLabel>
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
                  <PanelLabel>Bridge DSL</PanelLabel>
                  <div className="flex-1 min-h-0 px-3 pb-3">
                    <Editor
                      label=""
                      value={bridge}
                      onChange={setBridge}
                      language="bridge"
                    />
                  </div>
                </PanelBox>
              </Panel>
            </PanelGroup>
          </Panel>

          <ResizeHandle direction="horizontal" />

          {/* ── RIGHT column: Query/Context + Results ── */}
          <Panel defaultSize={50} minSize={20}>
            <PanelGroup
              direction="vertical"
              autoSaveId="bridge-playground-right-v"
              className="h-full"
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
                      <Editor
                        key={activeTabId}
                        label=""
                        value={activeQuery.query}
                        onChange={(v) => updateQuery(activeTabId, v)}
                        language="graphql-query"
                        graphqlSchema={graphqlSchema}
                      />
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
                    />
                  </div>
                </PanelBox>
              </Panel>
            </PanelGroup>
          </Panel>
        </PanelGroup>
      </div>
    </div>
  );
}
