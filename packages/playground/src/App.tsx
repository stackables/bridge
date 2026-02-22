import { useState, useCallback, useEffect } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Editor } from "./components/Editor";
import { ResultView } from "./components/ResultView";
import { examples } from "./examples";
import { runBridge, getDiagnostics } from "./engine";
import type { RunResult } from "./engine";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { ShareDialog } from "./components/ShareDialog";
import { getShareIdFromUrl, loadShare, clearShareIdFromUrl } from "./share";

// ── resize handle — transparent hit area, no visual indicator ────────────────
function ResizeHandle({ direction }: { direction: "horizontal" | "vertical" }) {
  return (
    <PanelResizeHandle
      className={cn(
        "shrink-0",
        direction === "horizontal" ? "w-2 cursor-[col-resize]" : "h-2 cursor-[row-resize]",
      )}
    />
  );
}

// ── diagnostics strip ─────────────────────────────────────────────────────────
function DiagnosticsBar({ bridgeText }: { bridgeText: string }) {
  const diagnostics = getDiagnostics(bridgeText).diagnostics;
  if (diagnostics.length === 0) return null;
  return (
    <div className="shrink-0 border-t border-slate-800 bg-slate-950 px-3.5 py-1.5 flex flex-col gap-1">
      {diagnostics.map((d, i) => (
        <div
          key={i}
          className={cn(
            "flex gap-2 font-mono text-xs",
            d.severity === "error" ? "text-red-300" : "text-yellow-200",
          )}
        >
          <span className="opacity-60">{d.severity === "error" ? "✗" : "⚠"}</span>
          <span>{d.message} (line {d.range.start.line + 1})</span>
        </div>
      ))}
    </div>
  );
}

// ── tab strip with Run button ─────────────────────────────────────────────────
type Tab = "query" | "context";
type TabStripProps = {
  active: Tab;
  onChange: (t: Tab) => void;
  onRun: () => void;
  runDisabled: boolean;
  running: boolean;
};
function TabStrip({ active, onChange, onRun, runDisabled, running }: TabStripProps) {
  const tab = (id: Tab, label: string) => (
    <button
      key={id}
      onClick={() => onChange(id)}
      className={cn(
        "uppercase px-3.5 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors",
        active === id
          ? "border-sky-400 text-slate-200"
          : "border-transparent text-slate-500 hover:text-slate-300",
      )}
    >
      {label}
    </button>
  );
  return (
    <div className="flex items-center shrink-0">
      {tab("query", "Query")}
      {tab("context", "Context")}
      <div className="flex-1" />
      <Button
        size="sm"
        onClick={onRun}
        disabled={runDisabled}
        className="text-xs h-7 px-3"
      >
        {running ? "Running…" : "▶  Run"}
      </Button>
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
  const [query, setQuery] = useState(ex.query);
  const [context, setContext] = useState(ex.context);
  const [result, setResult] = useState<RunResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("query");

  // Load shared playground state from ?s=<id> on first mount
  useEffect(() => {
    const id = getShareIdFromUrl();
    if (!id) return;
    clearShareIdFromUrl();
    loadShare(id)
      .then((payload) => {
        setSchema(payload.schema);
        setBridge(payload.bridge);
        setQuery(payload.query);
        setContext(payload.context);
        setResult(null);
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
    setQuery(e.query);
    setContext(e.context);
    setResult(null);
  }, []);

  const handleRun = useCallback(async () => {
    setLoading(true);
    setResult(null);
    try {
      const r = await runBridge(schema, bridge, query, {}, context);
      setResult(r);
    } finally {
      setLoading(false);
    }
  }, [schema, bridge, query, context]);

  const diagnostics = getDiagnostics(bridge).diagnostics;
  const hasErrors = diagnostics.some((d) => d.severity === "error");

  return (
    <div className="h-screen bg-slate-950 text-slate-200 font-sans flex flex-col overflow-hidden">
      {/* ── Header ── */}
      <header className="shrink-0 border-b border-slate-800 px-4 py-2 flex flex-wrap items-center gap-x-3 gap-y-2 md:px-5 md:py-2.5 md:gap-4">
        <a
          href="https://github.com/stackables/bridge"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2.5 no-underline"
        >
          <span className="text-xl font-bold text-sky-400 tracking-tight">Bridge</span>
          <Badge className="text-[10px] tracking-wider uppercase">Playground</Badge>
        </a>

        {/* Example picker */}
        <div className="flex items-center gap-2">
          <span className="hidden sm:block text-xs text-slate-600">Example:</span>
          <Select
            value={String(exampleIndex)}
            onValueChange={(v) => selectExample(Number(v))}
          >
            <SelectTrigger className="w-36 md:w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {examples.map((ex, i) => (
                <SelectItem key={i} value={String(i)}>{ex.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="ml-auto flex items-center gap-2 md:gap-3">
          <span className="hidden md:block text-xs text-slate-700">All code runs in-browser · no server required</span>
          <ShareDialog schema={schema} bridge={bridge} query={query} context={context} />
        </div>
      </header>

      {/* ── Mobile layout: vertical scrollable stack ── */}
      <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-3 md:hidden">
        {/* Schema panel */}
        <div className="bg-slate-800 rounded-xl flex flex-col overflow-hidden">
          <PanelLabel>GraphQL Schema</PanelLabel>
          <div className="h-64 px-3 pb-3">
            <Editor label="" value={schema} onChange={setSchema} language="graphql" />
          </div>
        </div>

        {/* Bridge DSL panel */}
        <div className="bg-slate-800 rounded-xl flex flex-col overflow-hidden">
          <PanelLabel>Bridge DSL</PanelLabel>
          <div className="h-64 px-3 pb-3">
            <Editor label="" value={bridge} onChange={setBridge} language="bridge" />
          </div>
          <DiagnosticsBar bridgeText={bridge} />
        </div>

        {/* Query / Context panel */}
        <div className="bg-slate-800 rounded-xl flex flex-col overflow-hidden">
          <div className="shrink-0 px-5 pt-1.5">
            <TabStrip
              active={activeTab}
              onChange={setActiveTab}
              onRun={handleRun}
              runDisabled={loading || hasErrors}
              running={loading}
            />
          </div>
          <div className="h-48 p-3 pt-2">
            {activeTab === "query" ? (
              <Editor label="" value={query} onChange={setQuery} language="graphql" />
            ) : (
              <Editor label="" value={context} onChange={setContext} language="json" />
            )}
          </div>
        </div>

        {/* Result panel */}
        <div className="bg-slate-800 rounded-xl flex flex-col overflow-hidden">
          <PanelLabel>Result</PanelLabel>
          <div className="h-64 px-3.5 pb-3.5 overflow-hidden flex flex-col">
            <ResultView
              result={result?.data}
              errors={result?.errors}
              loading={loading}
              traces={result?.traces}
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
                    <Editor label="" value={schema} onChange={setSchema} language="graphql" />
                  </div>
                </PanelBox>
              </Panel>

              <ResizeHandle direction="vertical" />

              {/* Bridge DSL panel */}
              <Panel defaultSize={65} minSize={20}>
                <PanelBox>
                  <PanelLabel>Bridge DSL</PanelLabel>
                  <div className="flex-1 min-h-0 px-3 pb-3">
                    <Editor label="" value={bridge} onChange={setBridge} language="bridge" />
                  </div>
                  <DiagnosticsBar bridgeText={bridge} />
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
                    <TabStrip
                      active={activeTab}
                      onChange={setActiveTab}
                      onRun={handleRun}
                      runDisabled={loading || hasErrors}
                      running={loading}
                    />
                  </PanelLabel>

                  <div className="flex-1 min-h-0 p-3 pt-0">
                    {activeTab === "query" ? (
                      <Editor label="" value={query} onChange={setQuery} language="graphql" />
                    ) : (
                      <Editor label="" value={context} onChange={setContext} language="json" />
                    )}
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
                      result={result?.data}
                      errors={result?.errors}
                      loading={loading}
                      traces={result?.traces}
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
