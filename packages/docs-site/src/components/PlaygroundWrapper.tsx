import { useState, useCallback, useEffect, useRef } from "react";
import { Playground } from "@stackables/bridge-playground";
import type { PlaygroundState } from "@stackables/bridge-playground";
import "@stackables/bridge-playground/style.css";
import { examples } from "../examples";
import { ShareDialog } from "./ShareDialog";
import {
  getShareIdFromUrl,
  loadShare,
  clearShareIdFromUrl,
} from "../share";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";

function exampleToState(ex: (typeof examples)[number]): PlaygroundState {
  return {
    schema: ex.schema,
    bridge: ex.bridge,
    context: ex.context,
    queries: ex.queries,
  };
}

export default function PlaygroundWrapper() {
  const [exampleIndex, setExampleIndex] = useState(0);
  const [resetKey, setResetKey] = useState(0);
  const [initialState, setInitialState] = useState<PlaygroundState>(() =>
    exampleToState(examples[0]!),
  );
  const currentStateRef = useRef<PlaygroundState>(initialState);

  // Load shared playground state from ?s=<id> on first mount
  useEffect(() => {
    const id = getShareIdFromUrl();
    if (!id) return;
    clearShareIdFromUrl();
    loadShare(id)
      .then((payload) => {
        currentStateRef.current = payload;
        setInitialState(payload);
        setResetKey((k) => k + 1);
      })
      .catch(() => {
        // silently ignore — invalid/expired share id
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const selectExample = useCallback((index: number) => {
    const ex = examples[index] ?? examples[0]!;
    const state = exampleToState(ex);
    setExampleIndex(index);
    currentStateRef.current = state;
    setInitialState(state);
    setResetKey((k) => k + 1);
  }, []);

  const handleStateChange = useCallback((state: PlaygroundState) => {
    currentStateRef.current = state;
  }, []);

  return (
    <div className="flex flex-col" style={{ height: "calc(100vh - var(--sl-nav-height, 3.5rem))" }}>
      {/* ── App-shell header: example picker + share ── */}
      <header className="shrink-0 border-b border-slate-800 bg-slate-950">
        {/* Row 1 (desktop): example picker + info + share */}
        <div className="px-4 py-2 flex items-center gap-3 md:px-5 md:py-2.5 md:gap-4">
          <div className="flex items-center gap-2 mr-auto">
            <Badge className="text-[10px] tracking-wider uppercase hidden md:inline-flex">
              Playground
            </Badge>

            {/* Example picker — desktop only */}
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
                  {examples.map((ex, i) => (
                    <SelectItem key={i} value={String(i)}>
                      {ex.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="ml-auto flex items-center gap-2 md:gap-3">
            <span className="hidden md:block text-xs text-slate-700">
              All code runs in-browser · no server required
            </span>
            <ShareDialog
              schema={currentStateRef.current.schema}
              bridge={currentStateRef.current.bridge}
              queries={currentStateRef.current.queries}
              context={currentStateRef.current.context}
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
              {examples.map((ex, i) => (
                <SelectItem key={i} value={String(i)}>
                  {ex.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </header>

      {/* ── Headless playground editor ── */}
      <div className="flex-1 min-h-0">
        <Playground
          key={resetKey}
          initialState={initialState}
          onStateChange={handleStateChange}
        />
      </div>
    </div>
  );
}
