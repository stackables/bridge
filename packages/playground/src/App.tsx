import { useEffect } from "react";
import { Playground } from "./Playground";
import { examples } from "./examples";
import { usePlaygroundState } from "./usePlaygroundState";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ShareDialog } from "./components/ShareDialog";
import { getShareIdFromUrl, loadShare, clearShareIdFromUrl } from "./share";
import { ChevronLeftIcon } from "lucide-react";

// ── main ──────────────────────────────────────────────────────────────────────
export function App() {
  const state = usePlaygroundState();
  const {
    exampleIndex,
    selectExample,
    mode,
    schema,
    bridge,
    queries,
    context,
  } = state;

  // Load shared playground state from ?s=<id> on first mount
  useEffect(() => {
    const id = getShareIdFromUrl();
    if (!id) return;
    clearShareIdFromUrl();
    loadShare(id)
      .then((payload) => state.loadSharePayload(payload))
      .catch(() => {
        // silently ignore — invalid/expired share id
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const isStandalone = mode === "standalone";

  return (
    <div className="h-full bg-slate-950 text-slate-200 font-sans flex flex-col overflow-hidden">
      {/* ── Header ── */}
      <header className="shrink-0 border-b border-slate-800">
        {/* Row 1: logo + (desktop: example picker + info) + share */}
        <div className="px-4 py-2 flex items-center gap-3 md:px-5 md:py-2.5 md:gap-4">
          <a href="/" className="flex items-center gap-2.5 no-underline">
            <span className="text-xl font-bold text-sky-400 tracking-tight flex items-center">
              <ChevronLeftIcon /> Documentation
            </span>
          </a>

          {/* Example picker — desktop only (row 1) */}
          <div className="hidden md:flex items-center gap-2">
            <span className="text-xs text-slate-600">Example:</span>
            <Select
              value={String(exampleIndex)}
              onValueChange={(v) => selectExample(Number(v))}
            >
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {examples.map((e, i) => (
                  <SelectItem key={i} value={String(i)}>
                    {e.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="ml-auto flex items-center gap-2 md:gap-3">
            <span className="hidden md:block text-xs text-slate-700">
              All code runs in-browser · no server required
            </span>
            <ShareDialog
              mode={mode}
              schema={schema}
              bridge={bridge}
              queries={queries.map((q) => ({ name: q.name, query: q.query }))}
              context={context}
              standaloneQueries={
                isStandalone
                  ? queries.map((q) => ({
                      operation: q.operation ?? "",
                      outputFields: q.outputFields ?? "",
                      inputJson: q.inputJson ?? "{}",
                    }))
                  : undefined
              }
            />
          </div>
        </div>

        {/* Row 2: example picker — mobile only */}
        <div className="md:hidden px-4 pb-2 flex items-center gap-2">
          <span className="text-xs text-slate-600">Example:</span>
          <Select
            value={String(exampleIndex)}
            onValueChange={(v) => selectExample(Number(v))}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {examples.map((e, i) => (
                <SelectItem key={i} value={String(i)}>
                  {e.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </header>

      <Playground {...state} />
    </div>
  );
}
