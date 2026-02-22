import { useState, useCallback } from "react";
import type { CSSProperties } from "react";
import { Editor } from "./components/Editor";
import { ResultView } from "./components/ResultView";
import { examples } from "./examples";
import { runBridge, getDiagnostics } from "./engine";
import type { RunResult } from "./engine";

const PANEL: CSSProperties = {
  background: "#1e293b",
  borderRadius: 12,
  padding: 20,
  display: "flex",
  flexDirection: "column",
  gap: 14,
};

const SECTION_LABEL: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: "#475569",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  marginBottom: -6,
};

export function App() {
  const [exampleIndex, setExampleIndex] = useState(0);
  const ex = examples[exampleIndex] ?? examples[0]!;

  const [schema, setSchema] = useState(ex.schema);
  const [bridge, setBridge] = useState(ex.bridge);
  const [query, setQuery] = useState(ex.query);
  const [context, setContext] = useState(ex.context);
  const [result, setResult] = useState<RunResult | null>(null);
  const [loading, setLoading] = useState(false);

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
      minHeight: "100vh",
      background: "#0f172a",
      color: "#e2e8f0",
      fontFamily: "system-ui, -apple-system, sans-serif",
      display: "flex",
      flexDirection: "column",
    }}>
      {/* ── Header ── */}
      <header style={{
        borderBottom: "1px solid #1e293b",
        padding: "12px 24px",
        display: "flex",
        alignItems: "center",
        gap: 16,
        flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
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
        </div>

        {/* Example picker dropdown */}
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

      {/* ── Description bar ── */}
      <div style={{ padding: "8px 24px", color: "#475569", fontSize: 12, borderBottom: "1px solid #0f172a", flexShrink: 0 }}>
        {ex.description}
      </div>

      {/* ── Two-column layout ── */}
      <div style={{
        flex: 1,
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 16,
        padding: "16px 24px 24px",
        minHeight: 0,
      }}>

        {/* ── LEFT: Definition panel ── */}
        <div style={{ ...PANEL, overflow: "auto" }}>
          <div style={SECTION_LABEL}>Definition</div>

          {/* GraphQL Schema */}
          <Editor label="GraphQL Schema" value={schema} onChange={setSchema} height="200px" />

          {/* Bridge DSL */}
          <Editor label="Bridge DSL" value={bridge} onChange={setBridge} height="280px" />

          {/* Diagnostics */}
          {diagnostics.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: "#475569", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                Diagnostics
              </label>
              <div style={{
                background: "#0f172a",
                border: "1px solid #1e293b",
                borderRadius: 8,
                padding: "8px 12px",
                display: "flex",
                flexDirection: "column",
                gap: 4,
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

        {/* ── RIGHT: Execute panel ── */}
        <div style={{ ...PANEL, overflow: "auto" }}>
          <div style={SECTION_LABEL}>Execute</div>

          {/* Context */}
          <Editor label="Context (JSON)" value={context} onChange={setContext} height="110px" />

          {/* Query */}
          <Editor label="GraphQL Query" value={query} onChange={setQuery} height="150px" />

          {/* Run button */}
          <button
            onClick={handleRun}
            disabled={loading || hasErrors}
            style={{
              padding: "9px 24px",
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

          {/* Result + Traces */}
          <ResultView
            result={result?.data}
            errors={result?.errors}
            loading={loading}
            traces={result?.traces}
          />
        </div>
      </div>
    </div>
  );
}
