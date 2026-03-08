import { useEffect, useMemo, useState } from "react";
import type { TraversalOperationPlans } from "@/engine";
import { cn } from "@/lib/utils";
import { Editor } from "./Editor";

type Props = {
  bridge: string;
  onBridgeChange: (value: string) => void;
  onFormatBridge: () => void;
  traversalPlans: TraversalOperationPlans[];
  autoHeight?: boolean;
};

export function BridgeDslPanel({
  bridge,
  onBridgeChange,
  onFormatBridge,
  traversalPlans,
  autoHeight = false,
}: Props) {
  const [tab, setTab] = useState<"dsl" | "traversal">("dsl");
  const [selectedOperation, setSelectedOperation] = useState<string | null>(null);
  const [selectedTraversalId, setSelectedTraversalId] = useState<string | null>(null);

  useEffect(() => {
    const firstOperation = traversalPlans[0]?.operation ?? null;
    if (!selectedOperation || !traversalPlans.some((plan) => plan.operation === selectedOperation)) {
      setSelectedOperation(firstOperation);
    }
  }, [selectedOperation, traversalPlans]);

  const activeOperation = useMemo(
    () => traversalPlans.find((plan) => plan.operation === selectedOperation) ?? traversalPlans[0] ?? null,
    [selectedOperation, traversalPlans],
  );

  useEffect(() => {
    const firstTraversalId = activeOperation?.plans[0]?.traversalId ?? null;
    if (!selectedTraversalId || !activeOperation?.plans.some((plan) => plan.traversalId === selectedTraversalId)) {
      setSelectedTraversalId(firstTraversalId);
    }
  }, [activeOperation, selectedTraversalId]);

  const selectedPlan = activeOperation?.plans.find(
    (plan) => plan.traversalId === selectedTraversalId,
  ) ?? activeOperation?.plans[0] ?? null;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between px-5 h-10 shrink-0">
        <span className="text-[11px] font-bold text-slate-200 uppercase tracking-widest">
          Bridge DSL
        </span>
        <div className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-900/70 p-1">
          <button
            onClick={() => setTab("dsl")}
            className={cn(
              "rounded-md px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide transition-colors",
              tab === "dsl"
                ? "bg-sky-400 text-slate-950"
                : "text-slate-400 hover:text-slate-200",
            )}
          >
            Source
          </button>
          <button
            onClick={() => setTab("traversal")}
            className={cn(
              "rounded-md px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide transition-colors",
              tab === "traversal"
                ? "bg-sky-400 text-slate-950"
                : "text-slate-400 hover:text-slate-200",
            )}
          >
            Traversal IDs
          </button>
        </div>
      </div>

      {tab === "dsl" ? (
        <div className={cn("px-3 pb-3", autoHeight ? "" : "flex-1 min-h-0")}>
          <Editor
            label=""
            value={bridge}
            onChange={onBridgeChange}
            language="bridge"
            autoHeight={autoHeight}
            onFormat={onFormatBridge}
          />
        </div>
      ) : (
        <div className={cn("px-3 pb-3", autoHeight ? "space-y-3" : "flex-1 min-h-0 overflow-hidden")}>
          <div className={cn("rounded-lg border border-slate-700/80 bg-slate-950/70", autoHeight ? "p-3 space-y-3" : "h-full overflow-hidden flex flex-col") }>
            {traversalPlans.length === 0 ? (
              <div className="p-4 text-sm text-slate-400">
                Fix Bridge DSL parse errors to inspect the traversal space.
              </div>
            ) : (
              <>
                <div className="shrink-0 border-b border-slate-800 px-3 py-3 space-y-3">
                  <div className="text-sm text-slate-200">
                    This bridge file has <span className="font-semibold text-sky-300">{traversalPlans.reduce((total, operation) => total + operation.plans.length, 0)}</span> static traversal ids.
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {traversalPlans.map((operation) => (
                      <button
                        key={operation.operation}
                        onClick={() => setSelectedOperation(operation.operation)}
                        className={cn(
                          "rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-wide transition-colors",
                          activeOperation?.operation === operation.operation
                            ? "border-sky-400 bg-sky-400/15 text-sky-200"
                            : "border-slate-700 text-slate-400 hover:border-slate-500 hover:text-slate-200",
                        )}
                      >
                        {operation.operation} · {operation.plans.length}
                      </button>
                    ))}
                  </div>
                </div>

                <div className={cn(autoHeight ? "space-y-3" : "flex flex-1 min-h-0 overflow-hidden") }>
                  <div className={cn("border-slate-800", autoHeight ? "space-y-2" : "w-full max-w-76 shrink-0 border-r overflow-y-auto") }>
                    {activeOperation?.plans.map((plan) => (
                      <button
                        key={plan.traversalId}
                        onClick={() => setSelectedTraversalId(plan.traversalId)}
                        className={cn(
                          "w-full text-left px-3 py-2.5 transition-colors",
                          selectedPlan?.traversalId === plan.traversalId
                            ? "bg-sky-400/10"
                            : "hover:bg-slate-900/80",
                        )}
                      >
                        <div className="font-mono text-[11px] text-sky-200 break-all">{plan.traversalId}</div>
                        <div className="mt-1 text-[11px] text-slate-500">
                          {plan.sites.length} site{plan.sites.length === 1 ? "" : "s"}
                        </div>
                      </button>
                    ))}
                  </div>

                  <div className={cn(autoHeight ? "space-y-3" : "flex-1 min-h-0 overflow-y-auto") }>
                    {selectedPlan ? (
                      <div className="p-3 space-y-3">
                        <div>
                          <div className="text-[11px] font-bold uppercase tracking-widest text-slate-500">
                            Selected ID
                          </div>
                          <div className="mt-1 font-mono text-xs text-sky-200 break-all">
                            {selectedPlan.traversalId}
                          </div>
                        </div>

                        {selectedPlan.sites.map((site) => (
                          <div
                            key={`${selectedPlan.traversalId}:${site.siteIndex}`}
                            className="rounded-lg border border-slate-800 bg-slate-900/80 p-3"
                          >
                            <div className="flex items-center justify-between gap-3">
                              <div className="font-mono text-sm text-slate-200">{site.path}</div>
                              <div className="text-[10px] uppercase tracking-wide text-slate-500">
                                {site.repeatable ? "repeatable site" : "single site"}
                              </div>
                            </div>
                            <div className="mt-2 space-y-2">
                              {site.outcomes.map((outcome) => (
                                <div key={outcome.raw} className="rounded-md border border-slate-800/80 bg-slate-950/70 px-2.5 py-2">
                                  <div className="text-xs text-slate-200">{outcome.summary}</div>
                                  <div className="mt-1 font-mono text-[10px] text-slate-500 break-all">{outcome.raw}</div>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}