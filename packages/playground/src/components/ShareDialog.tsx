import { useState, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { saveShare, shareUrl } from "../share";
import type { SharePayload } from "../share";

type Props = SharePayload;

type Phase = "idle" | "loading" | "done" | "error";

/** True when context is set to something other than an empty object. */
function hasContext(context: string): boolean {
  try {
    const parsed = JSON.parse(context.trim());
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return Object.keys(parsed).length > 0;
    }
  } catch {
    // unparseable is treated as non-empty
  }
  return context.trim().length > 0 && context.trim() !== "{}";
}

export function ShareDialog({ schema, bridge, query, context }: Props) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [url, setUrl] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [copied, setCopied] = useState(false);
  const urlInputRef = useRef<HTMLInputElement>(null);

  const contextFilled = hasContext(context);

  function reset() {
    setPhase("idle");
    setUrl("");
    setErrorMsg("");
    setCopied(false);
  }

  async function handleCreate() {
    setPhase("loading");
    try {
      const id = await saveShare({ schema, bridge, query, context });
      setUrl(shareUrl(id));
      setPhase("done");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Unknown error");
      setPhase("error");
    }
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Fallback for browsers without clipboard API
      urlInputRef.current?.select();
      document.execCommand("copy");
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 px-3 text-xs gap-1.5">
          <svg
            className="w-3.5 h-3.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="18" cy="5" r="3" />
            <circle cx="6" cy="12" r="3" />
            <circle cx="18" cy="19" r="3" />
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
            <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
          </svg>
          Share
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Share Playground</DialogTitle>
          <DialogDescription className="sr-only">Create a shareable link to this playground state</DialogDescription>
        </DialogHeader>

        <div className="p-5 flex flex-col gap-4">

          {/* Context warning */}
          {contextFilled && (
            <div className="flex gap-2.5 rounded-lg border border-amber-800 bg-amber-950/40 px-3.5 py-2.5 text-xs text-amber-300">
              <span className="shrink-0 mt-0.5">⚠</span>
              <span>
                Your <strong>Context</strong> tab contains data and will be included in the shared link.
                Remove any sensitive values (tokens, secrets) before sharing.
              </span>
            </div>
          )}

          {phase === "idle" && (
            <>
              <p className="text-sm text-slate-400">
                Creates a permanent link to the current schema, bridge, query
                {contextFilled ? ", and context" : ""}.
                Anyone with the link can view and run this playground.
              </p>
              <Button onClick={handleCreate} className="w-full">
                Create share link
              </Button>
            </>
          )}

          {phase === "loading" && (
            <Button disabled className="w-full">
              <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
              </svg>
              Creating link…
            </Button>
          )}

          {phase === "error" && (
            <>
              <div className="rounded-lg border border-red-800 bg-red-950/40 px-3.5 py-2.5 text-xs text-red-300">
                <strong>Error:</strong> {errorMsg}
              </div>
              <Button variant="outline" onClick={reset} className="w-full">
                Try again
              </Button>
            </>
          )}

          {phase === "done" && (
            <>
              <p className="text-sm text-slate-400">
                Share link created. The link is valid for 90 days.
              </p>
              <div className="flex gap-2">
                <input
                  ref={urlInputRef}
                  readOnly
                  value={url}
                  onClick={(e) => (e.target as HTMLInputElement).select()}
                  className="flex-1 min-w-0 rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 font-mono text-xs text-slate-200 outline-none focus:border-sky-400"
                />
                <Button
                  variant={copied ? "outline" : "default"}
                  size="sm"
                  onClick={handleCopy}
                  className="shrink-0 min-w-[68px]"
                >
                  {copied ? "✓ Copied" : "Copy"}
                </Button>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
