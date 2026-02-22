import { useState } from "react";
import type { ToolTrace } from "../engine";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Props = {
  traces: ToolTrace[];
};

function TraceRow({ trace, index }: { trace: ToolTrace; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = trace.input !== undefined || trace.output !== undefined || trace.error !== undefined;

  return (
    <div className="border-b border-slate-800 py-2">
      <div
        onClick={() => hasDetail && setExpanded(!expanded)}
        className={cn(
          "grid items-center gap-2",
          hasDetail ? "cursor-pointer" : "cursor-default",
        )}
        style={{ gridTemplateColumns: "24px 1fr auto auto" }}
      >
        <span className="text-right text-[11px] text-slate-600">{index + 1}</span>
        <span className={cn("font-mono text-xs", trace.error ? "text-red-300" : "text-slate-200")}>
          {trace.tool}
          {trace.tool !== trace.fn && (
            <span className="text-slate-600"> ({trace.fn})</span>
          )}
        </span>
        <span className={cn("font-mono text-[11px]", trace.error ? "text-red-300" : "text-green-400")}>
          {trace.durationMs.toFixed(1)}ms
        </span>
        {hasDetail && (
          <span className="text-[11px] text-slate-600">
            {expanded ? "▲" : "▼"}
          </span>
        )}
      </div>

      {expanded && (
        <div className="mt-1.5 pl-8 flex flex-col gap-1.5">
          {trace.error && (
            <div>
              <p className="text-[11px] text-slate-400 mb-0.5">ERROR</p>
              <pre className="m-0 font-mono text-xs text-red-300">{trace.error}</pre>
            </div>
          )}
          {trace.input !== undefined && (
            <div>
              <p className="text-[11px] text-slate-400 mb-0.5">INPUT</p>
              <pre className="m-0 rounded-md border border-slate-800 bg-slate-950 px-2.5 py-1.5 font-mono text-xs text-blue-300 overflow-x-auto">
                {JSON.stringify(trace.input, null, 2)}
              </pre>
            </div>
          )}
          {trace.output !== undefined && (
            <div>
              <p className="text-[11px] text-slate-400 mb-0.5">OUTPUT</p>
              <pre className="m-0 rounded-md border border-slate-800 bg-slate-950 px-2.5 py-1.5 font-mono text-xs text-green-300 overflow-x-auto">
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
  const totalMs = traces.reduce((sum, t) => sum + t.durationMs, 0);
  const hasErrors = traces.some((t) => t.error);

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            "font-mono text-xs",
            hasErrors
              ? "border-red-900 text-red-300 hover:bg-red-950 hover:text-red-200"
              : "border-sky-trace text-sky-400 hover:bg-slate-800 hover:text-sky-300",
          )}
        >
          <span>{hasErrors ? "⚠" : "⚡"}</span>
          <span>{traces.length} tool call{traces.length !== 1 ? "s" : ""}</span>
          <span className="text-slate-600">·</span>
          <span>{totalMs.toFixed(1)}ms total</span>
          <span className="text-slate-600 text-[11px]">— view traces</span>
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Tool Traces</DialogTitle>
          <DialogDescription>
            {traces.length} call{traces.length !== 1 ? "s" : ""} · {totalMs.toFixed(1)}ms
          </DialogDescription>
        </DialogHeader>
        <div className="overflow-y-auto px-5 pb-4">
          {traces.map((trace, i) => (
            <TraceRow key={i} trace={trace} index={i} />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

