import { useState } from "react";
import type { ToolTrace, LogEntry } from "../engine";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

// ── Shared detail dialog ─────────────────────────────────────────────────────

function DetailDialog({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="overflow-y-auto max-h-[60vh] p-4">{children}</div>
      </DialogContent>
    </Dialog>
  );
}

// ── Close button (shared) ────────────────────────────────────────────────────

function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="text-slate-600 hover:text-slate-300 transition-colors"
    >
      <svg
        className="w-3.5 h-3.5"
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
  );
}

// ── Trace detail dialog content ──────────────────────────────────────────────

function TraceDetailContent({ trace }: { trace: ToolTrace }) {
  return (
    <pre className="m-0 font-mono text-xs text-slate-300 overflow-x-auto whitespace-pre-wrap">
      {JSON.stringify(trace, null, 2)}
    </pre>
  );
}

// ── Trace inline row ─────────────────────────────────────────────────────────

function TraceRow({
  trace,
  index,
  onSelect,
}: {
  trace: ToolTrace;
  index: number;
  onSelect: () => void;
}) {
  const hasDetail =
    trace.input !== undefined ||
    trace.output !== undefined ||
    trace.error !== undefined;

  return (
    <button
      onClick={hasDetail ? onSelect : undefined}
      className={cn(
        "w-full flex items-center gap-2 font-mono text-[12px] leading-relaxed rounded px-1 -mx-1",
        hasDetail ? "cursor-pointer hover:bg-slate-800/60" : "cursor-default",
      )}
    >
      <span className="shrink-0 w-5 text-right text-[11px] text-slate-600">
        {index + 1}
      </span>
      <span
        className={cn(
          "flex-1 text-left truncate",
          trace.error ? "text-red-300" : "text-slate-300",
        )}
      >
        {trace.tool}
        {trace.tool !== trace.fn && (
          <span className="text-slate-600"> ({trace.fn})</span>
        )}
      </span>
      <span
        className={cn(
          "shrink-0 text-[11px]",
          trace.error ? "text-red-400" : "text-green-500",
        )}
      >
        {trace.durationMs.toFixed(1)}ms
      </span>
    </button>
  );
}

// ── Log inline row ───────────────────────────────────────────────────────────

const LOG_LEVEL_STYLES: Record<LogEntry["level"], string> = {
  debug: "text-slate-500",
  info: "text-sky-400",
  warn: "text-amber-400",
  error: "text-red-400",
};

function LogRow({
  entry,
  onSelect,
}: {
  entry: LogEntry;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className="w-full flex items-center gap-2 font-mono text-[12px] leading-relaxed rounded px-1 -mx-1 cursor-pointer hover:bg-slate-800/60"
    >
      <span
        className={cn(
          "shrink-0 uppercase w-10 text-right text-[11px]",
          LOG_LEVEL_STYLES[entry.level],
        )}
      >
        {entry.level}
      </span>
      <span className="flex-1 text-left text-slate-300 truncate">
        {entry.message}
      </span>
    </button>
  );
}

// ── Public: TracesToggle badge ───────────────────────────────────────────────

export function TracesToggle({
  traces,
  expanded,
  onToggle,
}: {
  traces: ToolTrace[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const totalMs = traces.reduce((sum, t) => sum + t.durationMs, 0);
  const hasErrors = traces.some((t) => t.error);
  return (
    <button
      onClick={onToggle}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors",
        expanded
          ? "border-sky-700 bg-sky-950 text-sky-300"
          : hasErrors
            ? "border-red-900 bg-red-950/40 text-red-300 hover:text-red-200"
            : "border-slate-700 bg-slate-800 text-slate-400 hover:text-slate-200",
      )}
    >
      <span>{hasErrors ? "⚠" : "⚡"}</span>
      <span>
        {traces.length} trace{traces.length !== 1 ? "s" : ""}
      </span>
      <span className="text-slate-600">·</span>
      <span>{totalMs.toFixed(1)}ms</span>
    </button>
  );
}

// ── Public: TracesContent panel ──────────────────────────────────────────────

export function TracesContent({
  traces,
  onClose,
}: {
  traces: ToolTrace[];
  onClose: () => void;
}) {
  const [selectedTrace, setSelectedTrace] = useState<ToolTrace | null>(null);
  return (
    <>
      <div className="rounded-lg border border-slate-800 bg-slate-950 overflow-hidden">
        <div className="px-3 py-2 border-b border-slate-800 flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Tool Traces
          </span>
          <CloseButton onClick={onClose} />
        </div>
        <div className="max-h-48 overflow-y-auto px-3 py-2 space-y-0.5">
          {traces.map((trace, i) => (
            <TraceRow
              key={i}
              trace={trace}
              index={i}
              onSelect={() => setSelectedTrace(trace)}
            />
          ))}
        </div>
      </div>
      {selectedTrace && (
        <DetailDialog
          open
          onOpenChange={() => setSelectedTrace(null)}
          title={selectedTrace.tool}
        >
          <TraceDetailContent trace={selectedTrace} />
        </DetailDialog>
      )}
    </>
  );
}

// ── Public: LogsToggle badge ─────────────────────────────────────────────────

export function LogsToggle({
  logs,
  expanded,
  onToggle,
}: {
  logs: LogEntry[];
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors",
        expanded
          ? "border-sky-700 bg-sky-950 text-sky-300"
          : "border-slate-700 bg-slate-800 text-slate-400 hover:text-slate-200",
      )}
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
        <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
      </svg>
      <span>
        {logs.length} log{logs.length !== 1 ? "s" : ""}
      </span>
    </button>
  );
}

// ── Public: LogsContent panel ────────────────────────────────────────────────

export function LogsContent({
  logs,
  onClose,
}: {
  logs: LogEntry[];
  onClose: () => void;
}) {
  const [selectedLog, setSelectedLog] = useState<LogEntry | null>(null);
  return (
    <>
      <div className="rounded-lg border border-slate-800 bg-slate-950 overflow-hidden">
        <div className="px-3 py-2 border-b border-slate-800 flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Engine Logs
          </span>
          <CloseButton onClick={onClose} />
        </div>
        <div className="max-h-48 overflow-y-auto px-3 py-2 space-y-0.5">
          {logs.map((entry, i) => (
            <LogRow
              key={i}
              entry={entry}
              onSelect={() => setSelectedLog(entry)}
            />
          ))}
        </div>
      </div>
      {selectedLog && (
        <DetailDialog
          open
          onOpenChange={() => setSelectedLog(null)}
          title="Log Entry"
        >
          <pre className="m-0 font-mono text-xs text-slate-300 overflow-x-auto whitespace-pre-wrap">
            {selectedLog.message}
          </pre>
        </DetailDialog>
      )}
    </>
  );
}
