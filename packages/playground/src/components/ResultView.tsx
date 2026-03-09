import { useState } from "react";
import {
  TracesToggle,
  TracesContent,
  LogsToggle,
  LogsContent,
} from "./TraceDialog";
import { Editor } from "./Editor";
import type { ToolTrace, LogEntry } from "../engine";
import { cn } from "@/lib/utils";

type Props = {
  result: unknown | null;
  errors: string[] | undefined;
  loading: boolean;
  traces?: ToolTrace[];
  logs?: LogEntry[];
  executionTrace?: bigint;
  onClearCache?: () => void;
  /** When true the result view sizes itself to its content instead of filling the parent. */
  autoHeight?: boolean;
};

export function ResultView({
  result,
  errors,
  loading,
  traces,
  logs,
  executionTrace,
  onClearCache,
  autoHeight = false,
}: Props) {
  const hasContent =
    loading || result !== undefined || (errors && errors.length > 0);
  const [activePanel, setActivePanel] = useState<"traces" | "logs" | null>(
    null,
  );

  const hasTraces = traces && traces.length > 0;
  const hasLogs = logs && logs.length > 0;
  const hasExecutionTrace = executionTrace != null && executionTrace > 0n;

  function toggle(panel: "traces" | "logs") {
    setActivePanel((v) => (v === panel ? null : panel));
  }

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
              <pre
                key={i}
                className="font-mono text-[13px] text-red-300 whitespace-pre-wrap wrap-break-word"
              >
                {err}
              </pre>
            ))}
          </div>
        )}

        {!loading && result !== undefined && (
          <div
            className={cn(
              "rounded-lg border border-slate-800 overflow-hidden",
              !autoHeight && "h-full",
            )}
          >
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

      {/* Badges row + expanded panel pinned to bottom */}
      {(hasTraces || hasLogs || hasExecutionTrace || onClearCache) && (
        <div className="shrink-0 pt-2.5 space-y-2">
          <div className="flex items-center gap-2">
            {hasExecutionTrace && (
              <span
                title={`Execution trace: ${executionTrace} (decimal)`}
                className="inline-flex items-center gap-1 rounded-full bg-indigo-900/50 border border-indigo-700/50 px-2 py-0.5 text-[10px] font-mono font-medium text-indigo-300"
              >
                trace 0x{executionTrace.toString(16)}
              </span>
            )}
            {hasTraces && (
              <TracesToggle
                traces={traces}
                expanded={activePanel === "traces"}
                onToggle={() => toggle("traces")}
              />
            )}
            {hasLogs && (
              <LogsToggle
                logs={logs}
                expanded={activePanel === "logs"}
                onToggle={() => toggle("logs")}
              />
            )}
            {onClearCache && (
              <button
                onClick={onClearCache}
                title="Clear HTTP response cache"
                className="ml-auto flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-slate-600 hover:text-slate-300 transition-colors"
              >
                <svg
                  className="w-3 h-3"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="1 4 1 10 7 10" />
                  <path d="M3.51 15a9 9 0 1 0 .49-4.95" />
                </svg>
                Clear Cache
              </button>
            )}
          </div>
          {activePanel === "traces" && hasTraces && (
            <TracesContent
              traces={traces}
              onClose={() => setActivePanel(null)}
            />
          )}
          {activePanel === "logs" && hasLogs && (
            <LogsContent logs={logs} onClose={() => setActivePanel(null)} />
          )}
        </div>
      )}
    </div>
  );
}
