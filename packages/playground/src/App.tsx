import { useState, useCallback } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Editor } from "./components/Editor";
import { ResultView } from "./components/ResultView";
import { examples } from "./examples";
import { runBridge, getDiagnostics } from "./engine";
import type { RunResult } from "./engine";

// ── resize handle — transparent hit area, no visual indicator ────────────────
function ResizeHandle({ direction }: { direction: "horizontal" | "vertical" }) {
  const isH = direction === "horizontal";
  return (
    <PanelResizeHandle style={{
      flexShrink: 0,
      [isH ? "width" : "height"]: 8,
      cursor: isH ? "col-resize" : "row-resize",
    }} />
  );
}

// ── diagnostics strip ─────────────────────────────────────────────────────────
function DiagnosticsBar({ bridgeText }: { bridgeText: string }) {
  const diagnostics = getDiagnostics(bridgeText).diagnostics;
  if (diagnostics.length === 0) return null;
  return (
    <div style={{
      flexShrink: 0,
      background: "#0f172a",
      borderTop: "1px solid #1e293b",
      padding: "6px 14px",
      display: "flex",
      flexDirection: "column",
      gap: 3,
    }}>
      {diagnostics.map((d, i) => (
        <div key={i} style={{
          color: d.severity === "error" ? "#fca5a5" : "#fde68a",
          fontFamily: "monospace",
          fontSize: 12,
          display: "flex",
          gap: 8,
        }}>
          <span style={{ opacity: 0.6 }}>{d.severity === "error" ? "✗" : "⚠"}</span>
          <span>{d.message} (line {d.range.start.line + 1})</span>
        </div>
      ))}
    </div>
  );
}

// ── tab strip with optional Run button ────────────────────────────────────────
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
      style={{
        padding: "6px 14px",
        background: "transparent",
        border: "none",
        borderBottom: active === id ? "2px solid #38bdf8" : "2px solid transparent",
        color: active === id ? "#e2e8f0" : "#475569",
        fontSize: 12,
        fontWeight: active === id ? 600 : 400,
        cursor: "pointer",
        letterSpacing: "0.03em",
      }}
    >
      {label}
    </button>
  );
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      borderBottom: "1px solid #1e293b",
      flexShrink: 0,
      padding: "12px 12px 0 12px",
    }}>
      {tab("query", "Query")}
      {tab("context", "Context")}
      <div style={{ flex: 1 }} />
      <button
        onClick={onRun}
        disabled={runDisabled}
        style={{
          padding: "4px 16px",
          background: runDisabled ? "#1e3a4a" : "#0ea5e9",
          color: runDisabled ? "#475569" : "#fff",
          border: "none",
          borderRadius: 5,
          fontSize: 12,
          fontWeight: 600,
          cursor: runDisabled ? "not-allowed" : "pointer",
          transition: "background 0.15s",
          marginRight: 4,
        }}
      >
        {running ? "Running…" : "▶  Run"}
      </button>
    </div>
  );
}

// ── panel wrapper ─────────────────────────────────────────────────────────────
function PanelBox({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      background: "#1e293b",
      borderRadius: 10,
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
      height: "100%",
    }}>
      {children}
    </div>
  );
}

// ── panel header label ─────────────────────────────────────────────────────────
function PanelLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 11,
      fontWeight: 700,
      color: "#475569",
      textTransform: "uppercase",
      letterSpacing: "0.08em",
      padding: "10px 14px 4px",
      flexShrink: 0,
    }}>
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
    <div style={{
      height: "100vh",
      background: "#0f172a",
      color: "#e2e8f0",
      fontFamily: "system-ui, -apple-system, sans-serif",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
    }}>
      {/* ── Header ── */}
      <header style={{
        borderBottom: "1px solid #1e293b",
        padding: "10px 20px",
        display: "flex",
        alignItems: "center",
        gap: 16,
        flexShrink: 0,
      }}>
        <a
          href="https://github.com/stackables/bridge"
          target="_blank"
          rel="noopener noreferrer"
          style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none" }}
        >
          <span style={{ fontSize: 20, fontWeight: 700, color: "#38bdf8", letterSpacing: "-0.02em" }}>
            Bridge
          </span>
          <span style={{
            background: "#164e63",
            color: "#38bdf8",
            fontSize: 10,
            fontWeight: 700,
            padding: "2px 7px",
            borderRadius: 99,
            letterSpacing: "0.07em",
          }}>
            PLAYGROUND
          </span>
        </a>

        {/* Example picker */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, color: "#475569" }}>Example:</span>
          <select
            value={exampleIndex}
            onChange={(e) => selectExample(Number(e.target.value))}
            style={{
              background: "#1e293b",
              color: "#e2e8f0",
              border: "1px solid #334155",
              borderRadius: 6,
              padding: "5px 10px",
              fontSize: 13,
              cursor: "pointer",
              outline: "none",
            }}
          >
            {examples.map((ex, i) => (
              <option key={i} value={i}>{ex.name}</option>
            ))}
          </select>
        </div>

        <div style={{ marginLeft: "auto", color: "#334155", fontSize: 12 }}>
          All code runs in-browser · no server required
        </div>
      </header>

      {/* ── Body: padding wrapper ensures panels never touch window edges ── */}
      <div style={{ flex: 1, minHeight: 0, padding: "12px 16px 16px", overflow: "hidden" }}>
        <PanelGroup
          direction="horizontal"
          autoSaveId="bridge-playground-h"
          style={{ height: "100%" }}
        >
          {/* ── LEFT column: Schema + Bridge ── */}
          <Panel defaultSize={50} minSize={20}>
            <PanelGroup
              direction="vertical"
              autoSaveId="bridge-playground-left-v"
              style={{ height: "100%" }}
            >
              {/* Schema panel */}
              <Panel defaultSize={35} minSize={15}>
                <PanelBox>
                  <PanelLabel>GraphQL Schema</PanelLabel>
                  <div style={{ flex: 1, minHeight: 0, padding: "4px 12px 12px" }}>
                    <Editor label="" value={schema} onChange={setSchema} />
                  </div>
                </PanelBox>
              </Panel>

              <ResizeHandle direction="vertical" />

              {/* Bridge DSL panel */}
              <Panel defaultSize={65} minSize={20}>
                <PanelBox>
                  <PanelLabel>Bridge DSL</PanelLabel>
                  <div style={{ flex: 1, minHeight: 0, padding: "4px 12px 12px" }}>
                    <Editor label="" value={bridge} onChange={setBridge} />
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
              style={{ height: "100%" }}
            >
              {/* Query / Context tabbed panel */}
              <Panel defaultSize={40} minSize={15}>
                <PanelBox>
                  <TabStrip
                    active={activeTab}
                    onChange={setActiveTab}
                    onRun={handleRun}
                    runDisabled={loading || hasErrors}
                    running={loading}
                  />
                  <div style={{ flex: 1, minHeight: 0, padding: "8px 12px 12px" }}>
                    {activeTab === "query" ? (
                      <Editor label="" value={query} onChange={setQuery} />
                    ) : (
                      <Editor label="" value={context} onChange={setContext} />
                    )}
                  </div>
                </PanelBox>
              </Panel>

              <ResizeHandle direction="vertical" />

              {/* Result panel */}
              <Panel defaultSize={60} minSize={20}>
                <PanelBox>
                  <PanelLabel>Result</PanelLabel>
                  {/* content fills height; ResultView handles internal scroll + trace pinned bottom */}
                  <div style={{ flex: 1, minHeight: 0, padding: "8px 14px 14px", overflow: "hidden", display: "flex", flexDirection: "column" }}>
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


