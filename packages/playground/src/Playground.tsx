import { useState, useCallback, useRef, useMemo } from "react";
import {
  Panel,
  Group,
  Separator,
  useDefaultLayout,
} from "react-resizable-panels";
import { Editor } from "./components/Editor";
import { ResultView } from "./components/ResultView";
import { StandaloneQueryPanel } from "./components/StandaloneQueryPanel";
import { clearHttpCache } from "./engine";
import type { RunResult, BridgeOperation, OutputFieldNode } from "./engine";
import type { GraphQLSchema } from "graphql";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { PlaygroundMode } from "./share";

// ── resize handle — transparent hit area, no visual indicator ────────────────
function ResizeHandle({ direction }: { direction: "horizontal" | "vertical" }) {
  return (
    <Separator
      className={cn(
        "shrink-0 outline-none",
        direction === "horizontal"
          ? "w-2 cursor-[col-resize]"
          : "h-2 cursor-[row-resize]",
      )}
    />
  );
}

// ── helpers ─────────────────────────────────────────────────────────────────
function contextIsFilled(context: string): boolean {
  try {
    const parsed = JSON.parse(context.trim());
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return Object.keys(parsed).length > 0;
    }
  } catch {
    return true; // unparseable treated as non-empty
  }
  return false;
}

// ── query tab type ────────────────────────────────────────────────────────────
export type QueryTab = {
  id: string;
  name: string;
  /** Whether the name was explicitly set by the user (disables auto-rename). */
  nameManual?: boolean;
  /** GraphQL query text (graphql mode). */
  query: string;
  /** Standalone mode fields — parallel to the graphql `query` field. */
  operation?: string;
  outputFields?: string;
  inputJson?: string;
};

// ── query tab bar ─────────────────────────────────────────────────────────────
type QueryTabBarProps = {
  queries: QueryTab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onAddQuery: () => void;
  onRemoveQuery: (id: string) => void;
  onRenameQuery: (id: string, name: string) => void;
  onRun: () => void;
  runDisabled: boolean;
  running: boolean;
  showRunButton?: boolean;
  contextFilled?: boolean;
};

function QueryTabBar({
  queries,
  activeTabId,
  onSelectTab,
  onAddQuery,
  onRemoveQuery,
  onRenameQuery,
  onRun,
  runDisabled,
  running,
  showRunButton = true,
  contextFilled = false,
}: QueryTabBarProps) {
  const isQueryTab = activeTabId !== "context";
  const canRemove = queries.length > 1;
  const [editingId, setEditingId] = useState<string | null>(null);
  const editRef = useRef<HTMLInputElement>(null);

  const commitRename = useCallback(
    (id: string) => {
      const val = editRef.current?.value.trim();
      if (val) onRenameQuery(id, val);
      setEditingId(null);
    },
    [onRenameQuery],
  );

  return (
    <div className="flex items-center shrink-0 gap-px">
      {/* Context tab — always first */}
      <button
        onClick={() => onSelectTab("context")}
        className={cn(
          "shrink-0 relative uppercase px-3.5 py-1.5 text-xs font-medium border-b-2 transition-colors whitespace-nowrap",
          activeTabId === "context"
            ? "border-sky-400 text-slate-200"
            : "border-transparent text-slate-500 hover:text-slate-300",
        )}
      >
        Context
        {contextFilled && activeTabId !== "context" && (
          <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-orange-500" />
        )}
      </button>

      {/* One tab per query */}
      {queries.map((q) => (
        <div
          key={q.id}
          className={cn(
            "group shrink-0 flex items-center border-b-2 -mb-px transition-colors",
            activeTabId === q.id
              ? "border-sky-400 text-slate-200"
              : "border-transparent text-slate-500 hover:text-slate-300",
          )}
        >
          {editingId === q.id ? (
            <input
              ref={editRef}
              defaultValue={q.name}
              autoFocus
              className="uppercase px-2 py-0.5 mx-1.5 text-xs font-medium bg-slate-900 border border-sky-400 rounded text-slate-200 outline-none w-28"
              onBlur={() => commitRename(q.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename(q.id);
                if (e.key === "Escape") setEditingId(null);
              }}
            />
          ) : (
            <button
              onClick={() => onSelectTab(q.id)}
              onDoubleClick={() => {
                setEditingId(q.id);
                onSelectTab(q.id);
              }}
              className="uppercase px-3.5 py-1.5 text-xs font-medium whitespace-nowrap"
              title="Double-click to rename"
            >
              {q.name}
            </button>
          )}
          {canRemove && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRemoveQuery(q.id);
              }}
              className="pr-2 -ml-1.5 text-slate-600 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
              title={`Close ${q.name}`}
            >
              <svg
                className="w-3 h-3"
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
          )}
        </div>
      ))}

      {/* Add query button */}
      <button
        onClick={onAddQuery}
        className="shrink-0 px-2 py-1.5 text-slate-600 hover:text-slate-300 transition-colors -mb-px border-b-2 border-transparent"
        title="Add query"
      >
        <svg
          className="w-3.5 h-3.5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
        >
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>

      <div className="flex-1" />

      {/* Run button — visible only when a query tab is active */}
      {showRunButton && isQueryTab && (
        <Button
          size="sm"
          onClick={onRun}
          disabled={runDisabled}
          className="shrink-0 text-xs h-7 px-3"
        >
          {running ? "Running…" : "▶  Run"}
        </Button>
      )}
    </div>
  );
}

// ── bridge DSL panel header (label only) ─────────────────────────────────────
function BridgeDslHeader({
  dslTab,
  onDslTabChange,
}: {
  dslTab: "dsl" | "manifest";
  onDslTabChange: (t: "dsl" | "manifest") => void;
}) {
  return (
    <div className="content-center shrink-0 px-5 h-10 flex items-center gap-4">
      <button
        onClick={() => onDslTabChange("dsl")}
        className={cn(
          "text-[11px] font-bold uppercase tracking-widest transition-colors",
          dslTab === "dsl" ? "text-slate-200" : "text-slate-500 hover:text-slate-300",
        )}
      >
        Bridge DSL
      </button>
      <button
        onClick={() => onDslTabChange("manifest")}
        className={cn(
          "text-[11px] font-bold uppercase tracking-widest transition-colors",
          dslTab === "manifest" ? "text-slate-200" : "text-slate-500 hover:text-slate-300",
        )}
      >
        Manifest
      </button>
    </div>
  );
}

// ── schema panel header with mode toggle ─────────────────────────────────────
function SchemaHeader({
  mode,
  onModeChange,
  hideGqlSwitch,
}: {
  mode: PlaygroundMode;
  onModeChange: (m: PlaygroundMode) => void;
  hideGqlSwitch?: boolean;
}) {
  return (
    <div className="content-center shrink-0 px-5 h-10 pt-1.5 pb-1.5 flex items-center justify-between">
      <span className="text-[11px] font-bold text-slate-200 uppercase tracking-widest">
        GraphQL Schema
      </span>
      {!hideGqlSwitch && (
        <button
          onClick={() =>
            onModeChange(mode === "graphql" ? "standalone" : "graphql")
          }
          className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-slate-500 hover:text-slate-300 transition-colors"
          title={
            mode === "graphql"
              ? "Switch to standalone mode (no GraphQL)"
              : "Switch to GraphQL mode"
          }
        >
          <span className={mode === "graphql" ? "text-sky-400" : ""}>GQL</span>
          <span className="relative inline-flex h-4 w-7 items-center rounded-full border border-slate-600 bg-slate-900 transition-colors">
            <span
              className={cn(
                "inline-block h-2.5 w-2.5 rounded-full bg-sky-400 transition-transform",
                mode === "standalone" ? "translate-x-3.5" : "translate-x-0.5",
              )}
            />
          </span>
          <span className={mode === "standalone" ? "text-sky-400" : ""}>
            CLI
          </span>
        </button>
      )}
    </div>
  );
}

// ── manifest view ─────────────────────────────────────────────────────────────

import { getTraversalManifest, decodeExecutionTrace } from "./engine";
import type { TraversalEntry } from "./engine";

/** Group entries by target path (wireIndex) for visual grouping. */
type ManifestGroup = {
  label: string;
  entries: TraversalEntry[];
  hasAlternatives: boolean;
};

function buildGroups(manifest: TraversalEntry[]): ManifestGroup[] {
  const byWire = new Map<number, TraversalEntry[]>();
  const order: number[] = [];
  for (const e of manifest) {
    const key = e.wireIndex;
    let group = byWire.get(key);
    if (!group) {
      group = [];
      byWire.set(key, group);
      order.push(key);
    }
    group.push(e);
  }
  return order.map((key) => {
    const entries = byWire.get(key)!;
    const label =
      entries[0].target.length > 0 ? entries[0].target.join(".") : "*";
    return {
      label,
      entries,
      hasAlternatives: entries.length > 1,
    };
  });
}

const kindColors: Record<string, string> = {
  primary: "bg-sky-900/50 text-sky-300 border-sky-700/50",
  fallback: "bg-amber-900/50 text-amber-300 border-amber-700/50",
  catch: "bg-red-900/50 text-red-300 border-red-700/50",
  "empty-array": "bg-slate-700/50 text-slate-400 border-slate-600/50",
  then: "bg-emerald-900/50 text-emerald-300 border-emerald-700/50",
  else: "bg-orange-900/50 text-orange-300 border-orange-700/50",
  const: "bg-violet-900/50 text-violet-300 border-violet-700/50",
};

function ManifestView({
  bridge,
  operation,
  executionTrace,
  autoHeight = false,
}: {
  bridge: string;
  operation: string;
  executionTrace?: bigint;
  autoHeight?: boolean;
}) {
  const manifest = useMemo(
    () => getTraversalManifest(bridge, operation),
    [bridge, operation],
  );
  const activeIds = useMemo(() => {
    if (executionTrace == null || executionTrace === 0n || manifest.length === 0)
      return new Set<string>();
    const decoded = decodeExecutionTrace(manifest, executionTrace);
    return new Set(decoded.map((e) => e.id));
  }, [manifest, executionTrace]);

  const groups = useMemo(() => buildGroups(manifest), [manifest]);
  const hasAnyAlternatives = groups.some((g) => g.hasAlternatives);
  const [showAllPaths, setShowAllPaths] = useState(true);

  if (!operation || manifest.length === 0) {
    return (
      <p className="py-4 px-3 font-mono text-[13px] text-slate-700">
        No bridge operation selected.
      </p>
    );
  }

  const visibleGroups = showAllPaths
    ? groups
    : groups.filter((g) => g.hasAlternatives);

  return (
    <div
      className={cn(
        "overflow-y-auto",
        autoHeight ? "max-h-[60vh]" : "h-full",
      )}
    >
      {/* Filter toggle */}
      {hasAnyAlternatives && (
        <div className="sticky top-0 z-10 bg-slate-800/95 backdrop-blur-sm px-3 py-1.5 flex items-center gap-2 border-b border-slate-700/50">
          <button
            onClick={() => setShowAllPaths((v) => !v)}
            className={cn(
              "text-[10px] font-medium uppercase tracking-wide transition-colors",
              showAllPaths
                ? "text-slate-500 hover:text-slate-300"
                : "text-indigo-400 hover:text-indigo-300",
            )}
          >
            {showAllPaths ? "Show alternatives only" : "Show all paths"}
          </button>
          <span className="text-[10px] text-slate-600">
            {visibleGroups.length}/{groups.length} groups
          </span>
        </div>
      )}

      <div className="px-3 pb-3 pt-1 space-y-2">
        {visibleGroups.map((group) => (
          <div
            key={group.entries[0].id}
            className={cn(
              "rounded-lg overflow-hidden",
              group.hasAlternatives
                ? "border border-slate-700/60 bg-slate-900/30"
                : "",
            )}
          >
            {/* Group header — target path (only for groups with alternatives) */}
            {group.hasAlternatives && (
              <div className="px-2.5 py-1 text-[11px] font-mono font-medium text-slate-300 bg-slate-800/50 border-b border-slate-700/40">
                {group.label}
              </div>
            )}

            {/* Entries */}
            <div className={group.hasAlternatives ? "p-1 space-y-0.5" : "space-y-0.5"}>
              {group.entries.map((entry) => {
                const isActive = activeIds.has(entry.id);
                return (
                  <div
                    key={entry.id}
                    className={cn(
                      "flex items-center gap-2 px-2.5 py-1 rounded-md text-[12px] font-mono transition-all",
                      isActive
                        ? "bg-slate-700/80 ring-1 ring-indigo-500/50"
                        : group.hasAlternatives
                          ? "bg-slate-900/40 opacity-60"
                          : "bg-slate-900/20 opacity-50",
                    )}
                  >
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full border px-1.5 py-0 text-[9px] font-bold uppercase tracking-wide shrink-0",
                        kindColors[entry.kind] ??
                          "bg-slate-700 text-slate-400 border-slate-600",
                      )}
                    >
                      {entry.kind}
                    </span>
                    {/* Show target label for entries without group header */}
                    {!group.hasAlternatives && (
                      <span
                        className={cn(
                          "truncate",
                          isActive ? "text-slate-200" : "text-slate-500",
                        )}
                        title={entry.id}
                      >
                        {entry.target.length > 0
                          ? entry.target.join(".")
                          : "*"}
                      </span>
                    )}
                    {entry.gateType && (
                      <span className="text-[10px] text-slate-600 shrink-0">
                        {entry.gateType === "falsy" ? "||" : "??"}
                      </span>
                    )}
                    {isActive && (
                      <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 shrink-0 ml-auto" />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── panel wrapper ─────────────────────────────────────────────────────────────
function PanelBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-slate-800 rounded-xl flex flex-col overflow-hidden h-full">
      {children}
    </div>
  );
}

// ── panel header label ─────────────────────────────────────────────────────────
function PanelLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="content-center shrink-0 px-4 min-h-10 pt-1.5 pb-1.5 text-[11px] font-bold text-slate-200 uppercase tracking-widest">
      {children}
    </div>
  );
}

// ── main ──────────────────────────────────────────────────────────────────────
export type PlaygroundProps = {
  mode: PlaygroundMode;
  onModeChange: (m: PlaygroundMode) => void;
  schema: string;
  onSchemaChange: (s: string) => void;
  bridge: string;
  onBridgeChange: (b: string) => void;
  onFormatBridge: () => void;
  context: string;
  onContextChange: (c: string) => void;
  queries: QueryTab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onAddQuery: () => void;
  onRemoveQuery: (id: string) => void;
  onRenameQuery: (id: string, name: string) => void;
  onUpdateQuery: (id: string, text: string) => void;
  onUpdateStandaloneField: (
    id: string,
    field: "operation" | "outputFields" | "inputJson",
    value: string,
  ) => void;
  displayResult: RunResult | null;
  displayRunning: boolean;
  hasErrors: boolean;
  isActiveRunning: boolean;
  onRun: () => void;
  graphqlSchema?: GraphQLSchema;
  bridgeOperations: BridgeOperation[];
  availableOutputFields: OutputFieldNode[];
  hideGqlSwitch?: boolean;
};

export function Playground({
  mode,
  onModeChange,
  schema,
  onSchemaChange,
  bridge,
  onBridgeChange,
  onFormatBridge,
  context,
  onContextChange,
  queries,
  activeTabId,
  onSelectTab,
  onAddQuery,
  onRemoveQuery,
  onRenameQuery,
  onUpdateQuery,
  onUpdateStandaloneField,
  displayResult,
  displayRunning,
  hasErrors,
  isActiveRunning,
  onRun,
  graphqlSchema,
  bridgeOperations,
  availableOutputFields,
  hideGqlSwitch,
}: PlaygroundProps) {
  const hLayout = useDefaultLayout({ id: "bridge-playground-h" });
  const leftVLayout = useDefaultLayout({ id: "bridge-playground-left-v" });
  const rightVLayout = useDefaultLayout({ id: "bridge-playground-right-v" });

  const activeQuery = queries.find((q) => q.id === activeTabId);
  const isStandalone = mode === "standalone";
  const [activeDslTab, setActiveDslTab] = useState<"dsl" | "manifest">("dsl");

  // Determine which operation to use for manifest
  const manifestOperation = useMemo(() => {
    if (isStandalone && activeQuery?.operation) return activeQuery.operation;
    if (bridgeOperations.length > 0) return bridgeOperations[0].label;
    return "";
  }, [isStandalone, activeQuery?.operation, bridgeOperations]);

  return (
    <>
      {/* ── Mobile layout: vertical scrollable stack ── */}
      <div className="flex-1 p-3 flex flex-col gap-3 md:hidden">
        {/* Schema panel — hidden in standalone mode, shows mode toggle */}
        {!isStandalone ? (
          <div className="bg-slate-800 rounded-xl flex flex-col overflow-hidden">
            <SchemaHeader
              mode={mode}
              onModeChange={onModeChange}
              hideGqlSwitch={hideGqlSwitch}
            />
            <div className="px-3 pb-3">
              <Editor
                label=""
                value={schema}
                onChange={onSchemaChange}
                language="graphql"
                autoHeight
              />
            </div>
          </div>
        ) : !hideGqlSwitch ? (
          /* When in standalone, show a collapsed "GraphQL Schema" bar with the toggle (if not hidden) */
          <div className="bg-slate-800 rounded-xl flex flex-col overflow-hidden">
            <SchemaHeader
              mode={mode}
              onModeChange={onModeChange}
              hideGqlSwitch={hideGqlSwitch}
            />
          </div>
        ) : null}

        {/* Bridge DSL panel */}
        <div className="bg-slate-800 rounded-xl flex flex-col overflow-hidden">
          <BridgeDslHeader dslTab={activeDslTab} onDslTabChange={setActiveDslTab} />
          <div className="px-3 pb-3">
            {activeDslTab === "dsl" ? (
              <Editor
                label=""
                value={bridge}
                onChange={onBridgeChange}
                language="bridge"
                autoHeight
                onFormat={onFormatBridge}
              />
            ) : (
              <ManifestView
                bridge={bridge}
                operation={manifestOperation}
                executionTrace={displayResult?.executionTrace}
                autoHeight
              />
            )}
          </div>
        </div>

        {/* Query / Context panel */}
        <div className="bg-slate-800 rounded-xl flex flex-col overflow-hidden">
          <div className="shrink-0 px-5 pt-1.5">
            <QueryTabBar
              queries={queries}
              activeTabId={activeTabId}
              onSelectTab={onSelectTab}
              onAddQuery={onAddQuery}
              onRemoveQuery={onRemoveQuery}
              onRenameQuery={onRenameQuery}
              onRun={onRun}
              runDisabled={isActiveRunning || hasErrors}
              running={isActiveRunning}
              showRunButton={false}
              contextFilled={contextIsFilled(context)}
            />
          </div>
          <div className="p-3 pt-2">
            {activeTabId === "context" ? (
              <Editor
                label=""
                value={context}
                onChange={onContextChange}
                language="json"
                autoHeight
              />
            ) : activeQuery ? (
              isStandalone ? (
                <StandaloneQueryPanel
                  operations={bridgeOperations}
                  operation={activeQuery.operation ?? ""}
                  onOperationChange={(v) =>
                    onUpdateStandaloneField(activeTabId, "operation", v)
                  }
                  availableFields={availableOutputFields}
                  outputFields={activeQuery.outputFields ?? ""}
                  onOutputFieldsChange={(v) =>
                    onUpdateStandaloneField(activeTabId, "outputFields", v)
                  }
                  inputJson={activeQuery.inputJson ?? "{}"}
                  onInputJsonChange={(v) =>
                    onUpdateStandaloneField(activeTabId, "inputJson", v)
                  }
                  autoHeight
                />
              ) : (
                <Editor
                  key={activeTabId}
                  label=""
                  value={activeQuery.query}
                  onChange={(v) => onUpdateQuery(activeTabId, v)}
                  language="graphql-query"
                  graphqlSchema={graphqlSchema}
                  autoHeight
                />
              )
            ) : null}
          </div>
        </div>

        {/* Run button — full-width below query panel, mobile only */}
        {activeTabId !== "context" && (
          <Button
            onClick={onRun}
            disabled={isActiveRunning || hasErrors}
            className="w-full"
          >
            {isActiveRunning ? "Running…" : "▶  Run"}
          </Button>
        )}

        {/* Result panel */}
        <div className="bg-slate-800 rounded-xl flex flex-col overflow-hidden">
          <PanelLabel>Result</PanelLabel>
          <div className="px-3.5 pb-3.5 flex flex-col">
            <ResultView
              result={displayResult?.data}
              errors={displayResult?.errors}
              loading={displayRunning}
              traces={displayResult?.traces}
              logs={displayResult?.logs}
              executionTrace={displayResult?.executionTrace}
              onClearCache={clearHttpCache}
              autoHeight
            />
          </div>
        </div>
      </div>

      {/* ── Desktop layout: resizable panels ── */}
      <div className="flex-1 min-h-0 p-3 overflow-hidden hidden md:block">
        <Group
          orientation="horizontal"
          className="h-full"
          defaultLayout={hLayout.defaultLayout}
          onLayoutChanged={hLayout.onLayoutChanged}
        >
          {/* ── LEFT column: Schema + Bridge (or Bridge only) ── */}
          <Panel defaultSize={50} minSize={20}>
            {isStandalone ? (
              /* Standalone: collapsed schema header + bridge fills left column */
              <div className="flex flex-col h-full gap-2">
                {!hideGqlSwitch && (
                  <div className="shrink-0 bg-slate-800 rounded-xl overflow-hidden">
                    <SchemaHeader
                      mode={mode}
                      onModeChange={onModeChange}
                      hideGqlSwitch={hideGqlSwitch}
                    />
                  </div>
                )}
                <PanelBox>
                  <BridgeDslHeader dslTab={activeDslTab} onDslTabChange={setActiveDslTab} />
                  <div className="flex-1 min-h-0 px-3 pb-3">
                    {activeDslTab === "dsl" ? (
                      <Editor
                        label=""
                        value={bridge}
                        onChange={onBridgeChange}
                        language="bridge"
                        onFormat={onFormatBridge}
                      />
                    ) : (
                      <ManifestView
                        bridge={bridge}
                        operation={manifestOperation}
                        executionTrace={displayResult?.executionTrace}
                      />
                    )}
                  </div>
                </PanelBox>
              </div>
            ) : (
              /* GraphQL mode: schema + bridge in a vertical split */
              <Group
                orientation="vertical"
                className="h-full"
                defaultLayout={leftVLayout.defaultLayout}
                onLayoutChanged={leftVLayout.onLayoutChanged}
              >
                {/* Schema panel */}
                <Panel defaultSize={35} minSize={15}>
                  <PanelBox>
                    <SchemaHeader
                      mode={mode}
                      onModeChange={onModeChange}
                      hideGqlSwitch={hideGqlSwitch}
                    />
                    <div className="flex-1 min-h-0 px-3 pb-3">
                      <Editor
                        label=""
                        value={schema}
                        onChange={onSchemaChange}
                        language="graphql"
                      />
                    </div>
                  </PanelBox>
                </Panel>

                <ResizeHandle direction="vertical" />

                {/* Bridge DSL panel */}
                <Panel defaultSize={65} minSize={20}>
                  <PanelBox>
                    <BridgeDslHeader dslTab={activeDslTab} onDslTabChange={setActiveDslTab} />
                    <div className="flex-1 min-h-0 px-3 pb-3">
                      {activeDslTab === "dsl" ? (
                        <Editor
                          label=""
                          value={bridge}
                          onChange={onBridgeChange}
                          language="bridge"
                          onFormat={onFormatBridge}
                        />
                      ) : (
                        <ManifestView
                          bridge={bridge}
                          operation={manifestOperation}
                          executionTrace={displayResult?.executionTrace}
                        />
                      )}
                    </div>
                  </PanelBox>
                </Panel>
              </Group>
            )}
          </Panel>

          <ResizeHandle direction="horizontal" />

          {/* ── RIGHT column: Query/Context + Results ── */}
          <Panel defaultSize={50} minSize={20}>
            <Group
              orientation="vertical"
              className="h-full"
              defaultLayout={rightVLayout.defaultLayout}
              onLayoutChanged={rightVLayout.onLayoutChanged}
            >
              {/* Query / Context tabbed panel */}
              <Panel defaultSize={40} minSize={15}>
                <PanelBox>
                  <PanelLabel>
                    <QueryTabBar
                      queries={queries}
                      activeTabId={activeTabId}
                      onSelectTab={onSelectTab}
                      onAddQuery={onAddQuery}
                      onRemoveQuery={onRemoveQuery}
                      onRenameQuery={onRenameQuery}
                      onRun={onRun}
                      runDisabled={isActiveRunning || hasErrors}
                      running={isActiveRunning}
                      contextFilled={contextIsFilled(context)}
                    />
                  </PanelLabel>

                  <div className="flex-1 min-h-0 p-3 pt-0">
                    {activeTabId === "context" ? (
                      <Editor
                        label=""
                        value={context}
                        onChange={onContextChange}
                        language="json"
                      />
                    ) : activeQuery ? (
                      isStandalone ? (
                        <StandaloneQueryPanel
                          operations={bridgeOperations}
                          operation={activeQuery.operation ?? ""}
                          onOperationChange={(v) =>
                            onUpdateStandaloneField(activeTabId, "operation", v)
                          }
                          availableFields={availableOutputFields}
                          outputFields={activeQuery.outputFields ?? ""}
                          onOutputFieldsChange={(v) =>
                            onUpdateStandaloneField(
                              activeTabId,
                              "outputFields",
                              v,
                            )
                          }
                          inputJson={activeQuery.inputJson ?? "{}"}
                          onInputJsonChange={(v) =>
                            onUpdateStandaloneField(activeTabId, "inputJson", v)
                          }
                        />
                      ) : (
                        <Editor
                          key={activeTabId}
                          label=""
                          value={activeQuery.query}
                          onChange={(v) => onUpdateQuery(activeTabId, v)}
                          language="graphql-query"
                          graphqlSchema={graphqlSchema}
                        />
                      )
                    ) : null}
                  </div>
                </PanelBox>
              </Panel>

              <ResizeHandle direction="vertical" />

              {/* Result panel */}
              <Panel defaultSize={60} minSize={20}>
                <PanelBox>
                  <PanelLabel>Result</PanelLabel>
                  <div className="flex-1 min-h-0 px-3.5 pb-3.5 overflow-hidden flex flex-col">
                    <ResultView
                      result={displayResult?.data}
                      errors={displayResult?.errors}
                      loading={displayRunning}
                      traces={displayResult?.traces}
                      logs={displayResult?.logs}
                      executionTrace={displayResult?.executionTrace}
                      onClearCache={clearHttpCache}
                    />
                  </div>
                </PanelBox>
              </Panel>
            </Group>
          </Panel>
        </Group>
      </div>
    </>
  );
}
