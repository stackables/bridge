import { useState, useEffect, useRef } from "react";
import { Playground } from "./Playground";
import { usePlaygroundState } from "./usePlaygroundState";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";

export type DialogPlaygroundProps = {
  /** Label shown on the trigger button. */
  label?: string;
  /** Index of the built-in example to load initially (default: 0). */
  initialExample?: number;
  /** Disables switching to GraphQL mode. */
  hideGqlSwitch?: boolean;

  /** Optional custom bridge DSL. If provided, overrides `initialExample`. */
  bridge?: string;
  /** Optional custom context JSON string. */
  contextStr?: string;
  /** Optional operation to select initially (if omitted, auto-selects first). */
  operation?: string;
  /** Optional input JSON string. */
  inputJson?: string;
  /** Optional output fields (comma-separated). */
  outputFields?: string;
  /** Automatically run the query exactly once when the playground opens. */
  autoRun?: boolean;
};

// ── inner playground — mounts state only when dialog is opened ────────────────
function PlaygroundInner({
  initialExample = 0,
  hideGqlSwitch = true, // By default, hide it in dialog
  bridge,
  contextStr,
  operation,
  inputJson,
  outputFields,
  autoRun,
}: {
  initialExample?: number;
  hideGqlSwitch?: boolean;
  bridge?: string;
  contextStr?: string;
  operation?: string;
  inputJson?: string;
  outputFields?: string;
  autoRun?: boolean;
}) {
  const state = usePlaygroundState(initialExample, hideGqlSwitch, {
    bridge,
    contextStr,
    operation,
    inputJson,
    outputFields,
  });

  const { onRun } = state;
  const hasRunRef = useRef(false);
  const onRunRef = useRef(onRun);

  useEffect(() => {
    onRunRef.current = onRun;
  }, [onRun]);

  useEffect(() => {
    if (autoRun && !hasRunRef.current) {
      hasRunRef.current = true;
      // Small timeout to ensure editor layout stabilizes before potentially
      // showing loading overlays/results. Optional but safe.
      setTimeout(() => onRunRef.current(), 50);
    }
  }, [autoRun]);

  return (
    <div className="bridge-playground-root h-full rounded-xl bg-slate-950 text-slate-200 font-sans flex flex-col overflow-hidden">
      <Playground {...state} hideGqlSwitch={hideGqlSwitch} />
    </div>
  );
}

// ── main ──────────────────────────────────────────────────────────────────────
export function DialogPlayground({
  label = "Open Playground",
  initialExample = 0,
  hideGqlSwitch = true,
  bridge,
  contextStr,
  operation,
  inputJson,
  outputFields,
  autoRun,
}: DialogPlaygroundProps) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="default">{label}</Button>
      </DialogTrigger>
      <DialogContent
        onInteractOutside={(e) => {
          // react-resizable-panels handle clicks are sometimes erroneously interpreted
          // as outside interactions by the dialog when mounted in certain ways (e.g. Shadow DOM)
          const target = e.target;
          if (target instanceof Element && target.closest("[data-separator]")) {
            e.preventDefault();
          }
        }}
        className="max-w-[97vw] w-[97vw] h-[95vh] max-h-[95vh] p-0"
      >
        {open && (
          <PlaygroundInner
            initialExample={initialExample}
            hideGqlSwitch={hideGqlSwitch}
            bridge={bridge}
            contextStr={contextStr}
            operation={operation}
            inputJson={inputJson}
            outputFields={outputFields}
            autoRun={autoRun}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
