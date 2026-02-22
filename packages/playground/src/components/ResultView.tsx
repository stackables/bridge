import { TraceDialog } from "./TraceDialog";
import type { ToolTrace } from "../engine";

type Props = {
  result: unknown | null;
  errors: string[] | undefined;
  loading: boolean;
  traces?: ToolTrace[];
};

export function ResultView({ result, errors, loading, traces }: Props) {
  const hasContent = loading || result !== undefined || (errors && errors.length > 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Scrollable result area */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {loading && (
          <div style={{ padding: "16px 0", color: "#94a3b8", fontFamily: "monospace", fontSize: 13 }}>
            Running…
          </div>
        )}

        {!hasContent && (
          <div style={{ padding: "16px 0", color: "#334155", fontFamily: "monospace", fontSize: 13 }}>
            Press Run to execute the query.
          </div>
        )}

        {!loading && errors && errors.length > 0 && (
          <div style={{
            background: "#450a0a",
            border: "1px solid #7f1d1d",
            borderRadius: 8,
            padding: "10px 14px",
            marginBottom: 8,
          }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#fca5a5", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>
              Errors
            </div>
            {errors.map((err, i) => (
              <div key={i} style={{ color: "#fca5a5", fontFamily: "monospace", fontSize: 13 }}>{err}</div>
            ))}
          </div>
        )}

        {!loading && result !== undefined && (
          <pre style={{
            background: "#0f172a",
            border: "1px solid #1e293b",
            borderRadius: 8,
            padding: "10px 14px",
            margin: 0,
            color: "#86efac",
            fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
            fontSize: 13,
            lineHeight: 1.6,
            overflowX: "auto",
          }}>
            {JSON.stringify(result, null, 2)}
          </pre>
        )}
      </div>

      {/* Trace badge pinned to bottom */}
      {traces && traces.length > 0 && (
        <div style={{ flexShrink: 0, paddingTop: 10 }}>
          <TraceDialog traces={traces} />
        </div>
      )}
    </div>
  );
}

