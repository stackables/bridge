import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { examples } from "./examples";
import type { QueryTab } from "./Playground";
import {
  runBridge,
  runBridgeStandalone,
  getDiagnostics,
  extractBridgeOperations,
  extractOutputFields,
  extractTraversalPlans,
  extractInputSkeleton,
  mergeInputSkeleton,
  prettyPrintToSource,
} from "./engine";
import type { RunResult, TraversalOperationPlans } from "./engine";
import { buildSchema, type GraphQLSchema } from "graphql";
import type { PlaygroundMode, SharePayload } from "./share";

// ── build query tab array from an example ────────────────────────────────────
export function buildQueryTabs(e: (typeof examples)[number]): QueryTab[] {
  return e.queries.map((q, i) => {
    const sq = e.standaloneQueries?.[i];
    return {
      id: crypto.randomUUID(),
      name: q.name,
      nameManual: true,
      query: q.query,
      operation: sq?.operation ?? "",
      outputFields: sq?.outputFields ?? "",
      inputJson: sq ? JSON.stringify(sq.input, null, 2) : "{}",
    };
  });
}

// ── extract GraphQL operation name from query text ────────────────────────────
function extractOperationName(query: string): string | null {
  const named =
    /^\s*(?:query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)/m.exec(
      query,
    );
  if (named) return named[1]!;
  const anon = /^\s*\{\s*([A-Za-z_][A-Za-z0-9_]*)/m.exec(query);
  if (anon) return anon[1]!;
  return null;
}

function tryFormatJson(val?: string): string {
  if (!val) return "{}";
  try {
    return JSON.stringify(JSON.parse(val), null, 2);
  } catch {
    return val;
  }
}

function tryFormatBridge(source: string): string {
  try {
    return prettyPrintToSource(source);
  } catch {
    return source;
  }
}

export function usePlaygroundState(
  initialExampleIndex = 0,
  forceStandalone = false,
  overrides?: {
    bridge?: string;
    contextStr?: string;
    operation?: string;
    inputJson?: string;
    outputFields?: string;
  },
) {
  const [exampleIndex, setExampleIndex] = useState(initialExampleIndex);
  const ex = examples[exampleIndex] ?? examples[0]!;

  const [mode, setMode] = useState<PlaygroundMode>(
    forceStandalone ? "standalone" : (ex.mode ?? "standalone"),
  );

  // Format the default bridge if provided via overrides so it's not messy.
  const initialBridge = overrides?.bridge
    ? tryFormatBridge(overrides.bridge)
    : ex.bridge;
  const [schema, setSchema] = useState(ex.schema);
  const [bridge, setBridge] = useState(initialBridge);
  const [context, setContext] = useState(overrides?.contextStr ?? ex.context);

  const queryCounterRef = useRef(ex.queries.length);
  const [queries, setQueries] = useState<QueryTab[]>(() => {
    if (overrides?.bridge) {
      const ops = extractBridgeOperations(initialBridge);
      const firstOp = ops[0]?.label ?? "";
      const op = overrides.operation || firstOp;

      let initialJson = overrides.inputJson;
      if (!initialJson || initialJson === "{}") {
        initialJson = extractInputSkeleton(initialBridge, op);
      }

      return [
        {
          id: crypto.randomUUID(),
          name: "Query 1",
          query: "",
          operation: op,
          outputFields: overrides.outputFields ?? "",
          inputJson: tryFormatJson(initialJson),
        },
      ];
    }
    return buildQueryTabs(ex);
  });
  const [activeTabId, setActiveTabId] = useState<string>(
    () => queries[0]?.id ?? "context",
  );
  const [results, setResults] = useState<Record<string, RunResult>>({});
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());

  // Track the last active query so the result panel keeps showing when context tab is open
  const lastQueryIdRef = useRef(queries[0]?.id);
  if (activeTabId !== "context") lastQueryIdRef.current = activeTabId;
  const displayQueryId =
    activeTabId !== "context" ? activeTabId : lastQueryIdRef.current;
  const displayResult = displayQueryId
    ? (results[displayQueryId] ?? null)
    : null;
  const displayRunning = displayQueryId
    ? runningIds.has(displayQueryId)
    : false;

  const activeQuery = queries.find((q) => q.id === activeTabId);

  const selectExample = useCallback(
    (index: number) => {
      const e = examples[index] ?? examples[0]!;
      setExampleIndex(index);
      if (!forceStandalone && e.mode) setMode(e.mode);
      else if (forceStandalone) setMode("standalone");
      setSchema(e.schema);
      setBridge(e.bridge);
      queryCounterRef.current = e.queries.length;
      const newQ = buildQueryTabs(e);
      setQueries(newQ);
      setContext(e.context);
      setResults({});
      setRunningIds(new Set());
      setActiveTabId(newQ[0]?.id ?? "context");
    },
    [forceStandalone],
  );

  const updateQuery = useCallback((id: string, text: string) => {
    setQueries((prev) =>
      prev.map((q) => {
        if (q.id !== id) return q;
        if (!q.nameManual) {
          const opName = extractOperationName(text);
          if (opName) return { ...q, query: text, name: opName };
        }
        return { ...q, query: text };
      }),
    );
  }, []);

  const addQuery = useCallback(() => {
    queryCounterRef.current += 1;
    const tab: QueryTab = {
      id: crypto.randomUUID(),
      name: `Query ${queryCounterRef.current}`,
      query: "",
      operation: "",
      outputFields: "",
      inputJson: "{}",
    };
    setQueries((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
  }, []);

  const removeQuery = useCallback(
    (id: string) => {
      setQueries((prev) => {
        if (prev.length <= 1) return prev;
        const idx = prev.findIndex((q) => q.id === id);
        const next = prev.filter((q) => q.id !== id);
        if (activeTabId === id) {
          const fallback =
            next[Math.min(idx, next.length - 1)]?.id ?? "context";
          setActiveTabId(fallback);
        }
        return next;
      });
      setResults((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    },
    [activeTabId],
  );

  const renameQuery = useCallback((id: string, name: string) => {
    setQueries((prev) =>
      prev.map((q) => (q.id === id ? { ...q, name, nameManual: true } : q)),
    );
  }, []);

  const updateStandaloneField = useCallback(
    (
      id: string,
      field: "operation" | "outputFields" | "inputJson",
      value: string,
    ) => {
      setQueries((prev) =>
        prev.map((q) => {
          if (q.id !== id) return q;
          const updated = { ...q, [field]: value };
          if (field === "operation" && (!q.inputJson || q.inputJson === "{}")) {
            updated.inputJson = extractInputSkeleton(bridge, value);
          }
          return updated;
        }),
      );
    },
    [bridge],
  );

  const handleRun = useCallback(async () => {
    if (!activeQuery) return;
    const qId = activeQuery.id;
    setRunningIds((prev) => new Set(prev).add(qId));
    try {
      let r: RunResult;
      if (mode === "standalone") {
        r = await runBridgeStandalone(
          bridge,
          activeQuery.operation ?? "",
          activeQuery.inputJson ?? "{}",
          activeQuery.outputFields ?? "",
          context,
        );
      } else {
        r = await runBridge(schema, bridge, activeQuery.query, {}, context);
      }
      setResults((prev) => ({ ...prev, [qId]: r }));
    } finally {
      setRunningIds((prev) => {
        const next = new Set(prev);
        next.delete(qId);
        return next;
      });
    }
  }, [activeQuery, mode, schema, bridge, context]);

  const handleFormatBridge = useCallback(() => {
    setBridge(tryFormatBridge(bridge));
  }, [bridge]);

  const diagnostics = getDiagnostics(bridge).diagnostics;
  const hasErrors = diagnostics.some((d) => d.severity === "error");
  const isActiveRunning =
    activeTabId !== "context" && runningIds.has(activeTabId);

  const graphqlSchema = useMemo<GraphQLSchema | undefined>(() => {
    try {
      return buildSchema(schema);
    } catch {
      return undefined;
    }
  }, [schema]);

  const bridgeOperations = useMemo(
    () => extractBridgeOperations(bridge),
    [bridge],
  );

  // Auto-select first operation when the list changes and current selection is invalid
  useEffect(() => {
    if (mode !== "standalone" || bridgeOperations.length === 0) return;
    setQueries((prev) =>
      prev.map((q) => {
        if (
          q.operation &&
          bridgeOperations.some((op) => op.label === q.operation)
        )
          return q;
        return { ...q, operation: bridgeOperations[0]!.label };
      }),
    );
  }, [bridgeOperations, mode]);

  const handleModeChange = useCallback(
    (newMode: PlaygroundMode) => {
      setMode(newMode);
      if (newMode === "standalone") {
        const ops = extractBridgeOperations(bridge);
        const firstOp = ops[0]?.label ?? "";
        setQueries((prev) =>
          prev.map((q) => {
            const op =
              q.operation && ops.some((o) => o.label === q.operation)
                ? q.operation
                : firstOp;
            const inputJson =
              !q.inputJson || q.inputJson === "{}"
                ? extractInputSkeleton(bridge, op)
                : q.inputJson;
            return { ...q, operation: op, inputJson };
          }),
        );
      }
    },
    [bridge],
  );

  const activeOperation = activeQuery?.operation ?? "";
  const availableOutputFields = useMemo(
    () => extractOutputFields(bridge, activeOperation),
    [bridge, activeOperation],
  );

  const traversalPlans = useMemo<TraversalOperationPlans[]>(
    () => extractTraversalPlans(bridge),
    [bridge],
  );

  // When the bridge DSL changes in standalone mode, merge input fields and prune output fields
  const prevBridgeRef = useRef(bridge);
  useEffect(() => {
    if (prevBridgeRef.current === bridge) return;
    prevBridgeRef.current = bridge;
    if (mode !== "standalone") return;

    setQueries((prev) =>
      prev.map((q) => {
        const op = q.operation ?? "";
        if (!op) return q;

        const skeleton = extractInputSkeleton(bridge, op);
        const mergedInput = mergeInputSkeleton(q.inputJson ?? "{}", skeleton);

        const currentFields = extractOutputFields(bridge, op);
        const validPaths = new Set(currentFields.map((f) => f.path));
        const selectedFields = (q.outputFields ?? "")
          .split(",")
          .map((f) => f.trim())
          .filter((f) => f && validPaths.has(f));

        return {
          ...q,
          inputJson: mergedInput,
          outputFields: selectedFields.join(","),
        };
      }),
    );
  }, [bridge, mode]);

  return {
    // example picker
    exampleIndex,
    selectExample,
    // load from share payload (used by App after loading a ?s= URL)
    loadSharePayload(payload: SharePayload) {
      setMode(payload.mode ?? "standalone");
      setSchema(payload.schema);
      setBridge(payload.bridge);
      const newQ: QueryTab[] = payload.queries.map((q, i) => {
        const sq = payload.standaloneQueries?.[i];
        return {
          id: crypto.randomUUID(),
          name: q.name,
          nameManual: true,
          query: q.query,
          operation: sq?.operation ?? "",
          outputFields: sq?.outputFields ?? "",
          inputJson: sq?.inputJson ?? "{}",
        };
      });
      queryCounterRef.current = newQ.length;
      setQueries(newQ);
      setContext(payload.context);
      setResults({});
      setRunningIds(new Set());
      setActiveTabId(newQ[0]?.id ?? "context");
    },
    // playground props
    mode,
    onModeChange: handleModeChange,
    schema,
    onSchemaChange: setSchema,
    bridge,
    onBridgeChange: setBridge,
    onFormatBridge: handleFormatBridge,
    context,
    onContextChange: setContext,
    queries,
    activeTabId,
    onSelectTab: setActiveTabId,
    onAddQuery: addQuery,
    onRemoveQuery: removeQuery,
    onRenameQuery: renameQuery,
    onUpdateQuery: updateQuery,
    onUpdateStandaloneField: updateStandaloneField,
    displayResult,
    displayRunning,
    hasErrors,
    isActiveRunning,
    onRun: handleRun,
    graphqlSchema,
    bridgeOperations,
    availableOutputFields,
    traversalPlans,
  };
}
