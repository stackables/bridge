import { useState } from "react";
import type { ToolTrace } from "../engine";

type Props = {
  traces: ToolTrace[];
};

function TraceRow({ trace, index }: { trace: ToolTrace; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = trace.input !== undefined || trace.output !== undefined || trace.error !== undefined;

  return (
    <div style={{
      borderBottom: "1px solid #1e293b",
      padding: "8px 0",
    }}>
      <div
        onClick={() => hasDetail && setExpanded(!expanded)}
        style={{
          display: "grid",
          gridTemplateColumns: "24px 1fr auto auto",
          gap: 8,
          alignItems: "center",
          cursor: hasDetail ? "pointer" : "default",
        }}
      >
        <span style={{ color: "#475569", fontSize: 11, textAlign: "right" }}>{index + 1}</span>
        <span style={{ fontFamily: "monospace", fontSize: 12, color: trace.error ? "#fca5a5" : "#e2e8f0" }}>
          {trace.tool}
          {trace.tool !== trace.fn && (
            <span style={{ color: "#475569" }}> ({trace.fn})</span>
          )}
        </span>
        <span style={{
          fontSize: 11,
          color: trace.error ? "#fca5a5" : "#4ade80",
          fontFamily: "monospace",
        }}>
          {trace.durationMs.toFixed(1)}ms
        </span>
        {hasDetail && (
          <span style={{ color: "#475569", fontSize: 11 }}>
            {expanded ? "▲" : "▼"}
          </span>
        )}
      </div>

      {expanded && (
        <div style={{ marginTop: 6, paddingLeft: 32, display: "flex", flexDirection: "column", gap: 6 }}>
          {trace.error && (
            <div>
              <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 2 }}>ERROR</div>
              <pre style={{ margin: 0, fontFamily: "monospace", fontSize: 12, color: "#fca5a5" }}>{trace.error}</pre>
            </div>
          )}
          {trace.input !== undefined && (
            <div>
              <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 2 }}>INPUT</div>
              <pre style={{
                margin: 0,
                fontFamily: "monospace",
                fontSize: 12,
                color: "#93c5fd",
                background: "#0f172a",
                padding: "6px 10px",
                borderRadius: 6,
                overflowX: "auto",
              }}>
                {JSON.stringify(trace.input, null, 2)}
              </pre>
            </div>
          )}
          {trace.output !== undefined && (
            <div>
              <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 2 }}>OUTPUT</div>
              <pre style={{
                margin: 0,
                fontFamily: "monospace",
                fontSize: 12,
                color: "#86efac",
                background: "#0f172a",
                padding: "6px 10px",
                borderRadius: 6,
                overflowX: "auto",
              }}>
                {JSON.stringify(trace.output, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function TraceDialog({ traces }: Props) {
  const [open, setOpen] = useState(false);
  const totalMs = traces.reduce((sum, t) => sum + t.durationMs, 0);
  const hasErrors = traces.some((t) => t.error);

  return (
    <>
      {/* Inline summary badge */}
      <button
        onClick={() => setOpen(true)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 10px",
          background: "transparent",
          border: "1px solid",
          borderColor: hasErrors ? "#7f1d1d" : "#1e3a5f",
          borderRadius: 6,
          color: hasErrors ? "#fca5a5" : "#38bdf8",
          fontSize: 12,
          cursor: "pointer",
          fontFamily: "monospace",
        }}
      >
        <span>{hasErrors ? "⚠" : "⚡"}</span>
        <span>{traces.length} tool call{traces.length !== 1 ? "s" : ""}</span>
        <span style={{ color: "#475569" }}>·</span>
        <span>{totalMs.toFixed(1)}ms total</span>
        <span style={{ color: "#475569", fontSize: 11 }}>— view traces</span>
      </button>

      {/* Modal dialog */}
      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#1e293b",
              borderRadius: 12,
              border: "1px solid #334155",
              width: "min(680px, 95vw)",
              maxHeight: "80vh",
              display: "flex",
              flexDirection: "column",
              boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
            }}
          >
            {/* Dialog header */}
            <div style={{
              padding: "14px 20px",
              borderBottom: "1px solid #334155",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontWeight: 600, color: "#e2e8f0", fontSize: 14 }}>Tool Traces</span>
                <span style={{ fontSize: 12, color: "#475569", fontFamily: "monospace" }}>
                  {traces.length} calls · {totalMs.toFixed(1)}ms
                </span>
              </div>
              <button
                onClick={() => setOpen(false)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#475569",
                  fontSize: 18,
                  cursor: "pointer",
                  lineHeight: 1,
                  padding: "0 4px",
                }}
              >
                ×
              </button>
            </div>

            {/* Trace list */}
            <div style={{ overflowY: "auto", padding: "4px 20px 16px" }}>
              {traces.map((trace, i) => (
                <TraceRow key={i} trace={trace} index={i} />
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
