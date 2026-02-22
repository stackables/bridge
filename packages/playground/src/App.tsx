import { useState, useCallback } from "react";
import type { CSSProperties } from "react";
import { Editor } from "./components/Editor";
import { ResultView } from "./components/ResultView";
import { examples } from "./examples";
import { runBridge, getDiagnostics } from "./engine";
import type { RunResult } from "./engine";

const PANEL_STYLE: CSSProperties = {
  background: "#1e293b",
  borderRadius: 12,
  padding: 20,
  display: "flex",
  flexDirection: "column",
  gap: 16,
};

export function App() {
  const [exampleIndex, setExampleIndex] = useState(0);
  const ex = examples[exampleIndex] ?? examples[0]!;

  const [schema, setSchema] = useState(ex.schema);
  const [bridge, setBridge] = useState(ex.bridge);
  const [query, setQuery] = useState(ex.query);
  const [result, setResult] = useState<RunResult | null>(null);
  const [loading, setLoading] = useState(false);

  const selectExample = useCallback((index: number) => {
    const e = examples[index] ?? examples[0]!;
    setExampleIndex(index);
    setSchema(e.schema);
    setBridge(e.bridge);
    setQuery(e.query);
    setResult(null);
  }, []);

  const handleRun = useCallback(async () => {
    setLoading(true);
    setResult(null);
    try {
      const r = await runBridge(schema, bridge, query);
      setResult(r);
    } finally {
      setLoading(false);
    }
  }, [schema, bridge, query]);

  const diagnostics = getDiagnostics(bridge).diagnostics;
  const hasErrors = diagnostics.some((d) => d.severity === "error");

  return (
    <div style={{
      minHeight: "100vh",
      background: "#0f172a",
      color: "#e2e8f0",
      fontFamily: "system-ui, -apple-system, sans-serif",
      display: "flex",
      flexDirection: "column",
    }}>
      {/* Header */}
      <header style={{
        borderBottom: "1px solid #1e293b",
        padding: "14px 24px",
        display: "flex",
        alignItems: "center",
        gap: 24,
        flexWrap: "wrap",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 22, fontWeight: 700, color: "#38bdf8", letterSpacing: "-0.02em" }}>
            Bridge
          </span>
          <span style={{
            background: "#164e63",
            color: "#38bdf8",
            fontSize: 11,
            fontWeight: 600,
            padding: "2px 8px",
            borderRadius: 99,
            letterSpacing: "0.05em",
          }}>
            PLAYGROUND
          </span>
        </div>
        <nav style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {examples.map((e, i) => (
            <button
              key={i}
              onClick={() => selectExample(i)}
              style={{
                padding: "5px 14px",
                borderRadius: 6,
                border: "1px solid",
                borderColor: i === exampleIndex ? "#38bdf8" : "#334155",
                background: i === exampleIndex ? "#0c4a6e" : "transparent",
                color: i === exampleIndex ? "#38bdf8" : "#94a3b8",
                fontSize: 13,
                cursor: "pointer",
                fontWeight: i === exampleIndex ? 600 : 400,
                transition: "all 0.15s",
              }}
            >
              {e.name}
            </button>
          ))}
        </nav>
        <div style={{ marginLeft: "auto", color: "#475569", fontSize: 12 }}>
          All code runs in-browser · no server required
        </div>
      </header>

      {/* Description */}
      <div style={{ padding: "10px 24px", color: "#64748b", fontSize: 13 }}>
        {ex.description}
      </div>

      {/* Main content */}
      <main style={{
        flex: 1,
        padding: "0 24px 24px",
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gridTemplateRows: "auto auto",
        gap: 16,
      }}>
        {/* Left top: Schema */}
        <div style={PANEL_STYLE}>
          <Editor label="GraphQL Schema" value={schema} onChange={setSchema} height="220px" />
        </div>

        {/* Right top: Bridge DSL */}
        <div style={{ ...PANEL_STYLE, gridRow: "1 / 3" }}>
          <Editor label="Bridge DSL" value={bridge} onChange={setBridge} height="400px" />
          {diagnostics.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                Diagnostics
              </label>
              <div style={{
                background: "#0f172a",
                border: "1px solid #1e293b",
                borderRadius: 8,
                padding: "8px 12px",
              }}>
                {diagnostics.map((d, i) => (
                  <div key={i} style={{
                    color: d.severity === "error" ? "#fca5a5" : "#fde68a",
                    fontFamily: "monospace",
                    fontSize: 12,
                    display: "flex",
                    gap: 8,
                  }}>
                    <span style={{ opacity: 0.6 }}>
                      {d.severity === "error" ? "✗" : "⚠"}
                    </span>
                    <span>
                      {d.message}
                      {" "}(line {d.range.start.line + 1})
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Left bottom: Query + Run + Result */}
        <div style={PANEL_STYLE}>
          <Editor label="GraphQL Query" value={query} onChange={setQuery} height="140px" />
          <button
            onClick={handleRun}
            disabled={loading || hasErrors}
            style={{
              padding: "10px 24px",
              background: loading || hasErrors ? "#1e3a4a" : "#0ea5e9",
              color: loading || hasErrors ? "#475569" : "#fff",
              border: "none",
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 600,
              cursor: loading || hasErrors ? "not-allowed" : "pointer",
              transition: "background 0.15s",
              alignSelf: "flex-start",
            }}
          >
            {loading ? "Running…" : "▶  Run"}
          </button>
          <ResultView
            result={result?.data}
            errors={result?.errors}
            loading={loading}
          />
        </div>
      </main>
    </div>
  );
}
