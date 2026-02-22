import { TraceDialog } from "./TraceDialog";
import type { ToolTrace } from "../engine";

type Props = {
  result: unknown | null;
  errors: string[] | undefined;
  loading: boolean;
  traces?: ToolTrace[];
};

export function ResultView({ result, errors, loading, traces }: Props) {
  if (loading) {
    return (
      <div style={{ padding: 20, color: "#94a3b8", fontFamily: "monospace", fontSize: 13 }}>
        Running…
      </div>
    );
  }

  if (!result && !errors) {
    return (
      <div style={{ padding: 20, color: "#475569", fontFamily: "monospace", fontSize: 13 }}>
        Press <strong style={{ color: "#94a3b8" }}>Run</strong> to execute the query.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {errors && errors.length > 0 && (
        <div style={{
          background: "#450a0a",
          border: "1px solid #7f1d1d",
          borderRadius: 8,
          padding: "10px 14px",
        }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#fca5a5", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Errors
          </div>
          {errors.map((err, i) => (
            <div key={i} style={{ color: "#fca5a5", fontFamily: "monospace", fontSize: 13 }}>{err}</div>
          ))}
        </div>
      )}
      {result !== undefined && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Result
          </label>
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
            minHeight: 60,
          }}>
            {JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}
      {traces && traces.length > 0 && (
        <TraceDialog traces={traces} />
      )}
    </div>
  );
}
