import { useState } from "react";
import { Playground } from "./Playground";
import { usePlaygroundState } from "./usePlaygroundState";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";

export type DialogPlaygroundProps = {
  /** Label shown on the trigger button. */
  label?: string;
  /** Index of the example to load initially (default: 0). */
  initialExample?: number;
};

// ── inner playground — mounts state only when dialog is opened ────────────────
function PlaygroundInner({ initialExample = 0 }: { initialExample?: number }) {
  const state = usePlaygroundState(initialExample);
  return (
    <div className="bridge-playground-root h-full bg-slate-950 text-slate-200 font-sans flex flex-col overflow-auto">
      <Playground {...state} />
    </div>
  );
}

// ── main ──────────────────────────────────────────────────────────────────────
export function DialogPlayground({
  label = "Open Playground",
  initialExample = 0,
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
        className="max-w-[97vw] w-[97vw] h-[95vh] max-h-[95vh] p-0 overflow-hidden"
      >
        {open && <PlaygroundInner initialExample={initialExample} />}
      </DialogContent>
    </Dialog>
  );
}
