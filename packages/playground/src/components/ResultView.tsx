import { TraceDialog } from "./TraceDialog";
import { Editor } from "./Editor";
import type { ToolTrace } from "../engine";
import { cn } from "@/lib/utils";

type Props = {
  result: unknown | null;
  errors: string[] | undefined;
  loading: boolean;
  traces?: ToolTrace[];
  /** When true the result view sizes itself to its content instead of filling the parent. */
  autoHeight?: boolean;
};

export function ResultView({ result, errors, loading, traces, autoHeight = false }: Props) {
  const hasContent = loading || result !== undefined || (errors && errors.length > 0);

  return (
    <div className={cn(!autoHeight && "flex flex-col h-full")}>
      {/* Scrollable result area */}
      <div className={cn(!autoHeight && "flex-1 min-h-0 overflow-y-auto")}>
        {loading && (
          <p className="py-4 font-mono text-[13px] text-slate-400">Running…</p>
        )}

        {!hasContent && (
          <p className="py-4 font-mono text-[13px] text-slate-700">
            Press Run to execute the query.
          </p>
        )}

        {!loading && errors && errors.length > 0 && (
          <div className="rounded-lg border border-red-900 bg-red-950 p-3.5 mb-2">
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-red-300">
              Errors
            </p>
            {errors.map((err, i) => (
              <p key={i} className="font-mono text-[13px] text-red-300">{err}</p>
            ))}
          </div>
        )}

        {!loading && result !== undefined && (
          <div className={cn("rounded-lg border border-slate-800 overflow-hidden", !autoHeight && "h-full")}>
            <Editor
              label=""
              value={JSON.stringify(result, null, 2)}
              onChange={() => {}}
              language="json"
              readOnly
              autoHeight={autoHeight}
            />
          </div>
        )}
      </div>

      {/* Trace badge pinned to bottom */}
      {traces && traces.length > 0 && (
        <div className="shrink-0 pt-2.5">
          <TraceDialog traces={traces} />
        </div>
      )}
    </div>
  );
}


