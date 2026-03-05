/**
 * Browser-side Bridge engine runner.
 *
 * Parses Bridge DSL, applies bridgeTransform to a GraphQL schema built from
 * SDL, and executes a GraphQL query — all in-process with no HTTP server.
 */
import {
  parseBridgeChevrotain,
  parseBridgeDiagnostics,
  executeBridge,
  formatBridge,
} from "@stackables/bridge";
export { formatBridge };
import type {
  BridgeDiagnostic,
  Bridge,
  ToolTrace,
  Logger,
  CacheStore,
} from "@stackables/bridge";
import {
  bridgeTransform,
  std,
  getBridgeTraces,
  createHttpCall,
} from "@stackables/bridge";

// ── Playground HTTP cache: module-level, clearable from the UI ────────────────

const _httpCacheMap = new Map<string, { value: unknown; expiresAt: number }>();

/** Per-run callback — set before each runBridge(), cleared after. */
let _onCacheHit: ((key: string) => void) | null = null;

const playgroundHttpCache: CacheStore = {
  get(key) {
    const entry = _httpCacheMap.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      _httpCacheMap.delete(key);
      return undefined;
    }
    _onCacheHit?.(key);
    return entry.value;
  },
  set(key, value, ttlSeconds) {
    if (ttlSeconds <= 0) return;
    _httpCacheMap.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  },
};

const playgroundHttpCall = createHttpCall(
  globalThis.fetch,
  playgroundHttpCache,
);

/** Flush all cached HTTP responses in the playground. */
export function clearHttpCache(): void {
  _httpCacheMap.clear();
}
import { buildSchema, execute, parse as parseGql } from "graphql";

export type { ToolTrace };

export type LogEntry = {
  level: "debug" | "info" | "warn" | "error";
  message: string;
};

export type RunResult = {
  data?: unknown;
  errors?: string[];
  traces?: ToolTrace[];
  logs?: LogEntry[];
};

export type DiagnosticResult = {
  diagnostics: BridgeDiagnostic[];
};

/**
 * Parse bridge DSL and return diagnostics (errors / warnings).
 */
export function getDiagnostics(bridgeText: string): DiagnosticResult {
  const result = parseBridgeDiagnostics(bridgeText);
  return { diagnostics: result.diagnostics };
}

/**
 * Execute a GraphQL query against a Bridge-transformed in-memory schema.
 *
 * @param schemaSdl   GraphQL SDL string
 * @param bridgeText  Bridge DSL string
 * @param queryText   GraphQL query string
 * @param variables   Optional query variables
 * @param contextJson Optional JSON string for the GraphQL context
 */
export async function runBridge(
  schemaSdl: string,
  bridgeText: string,
  queryText: string,
  variables: Record<string, unknown> = {},
  contextJson = "{}",
): Promise<RunResult> {
  // 1. Build GraphQL schema from SDL
  let schema;
  try {
    schema = buildSchema(schemaSdl);
  } catch (err: unknown) {
    return {
      errors: [
        `Schema error: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  // 2. Parse Bridge DSL
  let instructions;
  try {
    instructions = parseBridgeChevrotain(bridgeText);
  } catch (err: unknown) {
    return {
      errors: [
        `Bridge parse error: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  // 3. Apply bridge transform (tracing always enabled for playground)
  // Collect structured logs from the engine
  const logs: LogEntry[] = [];

  /** Format printf-style log calls: "[bridge] tool %s (%s) done in %dms", a, b, c */
  function formatLog(args: unknown[]): string {
    if (args.length === 0) return "";
    const fmt = String(args[0]);
    let i = 1;
    const msg = fmt.replace(/%[sdioOjf%]/g, (token) => {
      if (token === "%%") return "%";
      if (i >= args.length) return token;
      const val = args[i++];
      switch (token) {
        case "%d":
        case "%i":
        case "%f":
          return String(Number(val));
        case "%o":
        case "%O":
        case "%j":
          try {
            return JSON.stringify(val);
          } catch {
            return String(val);
          }
        default:
          return String(val);
      }
    });
    // Append any extra args that weren't consumed by placeholders
    const rest = args.slice(i).map(String);
    return rest.length > 0 ? `${msg} ${rest.join(" ")}` : msg;
  }

  const collectingLogger: Logger = {
    debug: (...args: unknown[]) =>
      logs.push({ level: "debug", message: formatLog(args) }),
    info: (...args: unknown[]) =>
      logs.push({ level: "info", message: formatLog(args) }),
    warn: (...args: unknown[]) =>
      logs.push({ level: "warn", message: formatLog(args) }),
    error: (...args: unknown[]) =>
      logs.push({ level: "error", message: formatLog(args) }),
  };

  let transformedSchema;
  try {
    transformedSchema = bridgeTransform(schema, instructions, {
      tools: {
        std: { ...std, httpCall: playgroundHttpCall },
      },
      trace: "full",
      logger: collectingLogger,
    });
  } catch (err: unknown) {
    return {
      errors: [
        `Transform error: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  // 4. Parse GQL query
  let document;
  try {
    document = parseGql(queryText);
  } catch (err: unknown) {
    return {
      errors: [
        `Query parse error: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  // 5. Parse context JSON
  let contextValue: Record<string, unknown>;
  try {
    contextValue = contextJson.trim()
      ? (JSON.parse(contextJson) as Record<string, unknown>)
      : {};
  } catch (err: unknown) {
    return {
      errors: [
        `Context JSON error: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  // 6. Execute
  // Wire cache-hit notifications into this run's log stream (cleared in finally)
  _onCacheHit = (key: string) => {
    try {
      const url = new URL(key);
      logs.push({
        level: "info",
        message: `⚡ cache hit: ${url.pathname}${url.search}`,
      });
    } catch {
      logs.push({ level: "info", message: `⚡ cache hit: ${key}` });
    }
  };
  try {
    const result = await execute({
      schema: transformedSchema,
      document,
      variableValues: variables,
      contextValue,
    });

    const errors = result.errors?.map((e) => {
      const path = e.path ? ` (path: ${e.path.join(".")})` : "";
      return `${e.message}${path}`;
    });

    const traces = getBridgeTraces(contextValue);
    return {
      data: result.data,
      errors,
      traces: traces.length > 0 ? traces : undefined,
      logs: logs.length > 0 ? logs : undefined,
    };
  } catch (err: unknown) {
    return {
      errors: [
        `Execution error: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  } finally {
    _onCacheHit = null;
  }
}

// ── Standalone (no-GraphQL) helpers ──────────────────────────────────────────

export type BridgeOperation = { type: string; field: string; label: string };

/**
 * Extract all bridge operations from a Bridge DSL source string.
 * Returns e.g. `[{ type: "Query", field: "greet", label: "Query.greet" }]`.
 */
export function extractBridgeOperations(bridgeText: string): BridgeOperation[] {
  try {
    const { document } = parseBridgeDiagnostics(bridgeText);
    return document.instructions
      .filter((i): i is Bridge => i.kind === "bridge")
      .map((b) => ({
        type: b.type,
        field: b.field,
        label: `${b.type}.${b.field}`,
      }));
  } catch {
    return [];
  }
}

export type OutputFieldNode = {
  /** Segment name, e.g. "origin" */
  name: string;
  /** Full dot-separated path, e.g. "legs.origin" */
  path: string;
  /** Nesting depth (0 = top-level) */
  depth: number;
  /** Whether this path has children */
  hasChildren: boolean;
};

/**
 * Extract all possible output field paths for a specific bridge operation.
 *
 * Walks the parsed wires, collects every `to.path` that targets the output
 * trunk, and adds intermediate ancestor paths so the tree is complete.
 *
 * Returns a flat, depth-sorted list ready for rendering in a tree-style
 * dropdown (each node carries its depth for indentation).
 */
export function extractOutputFields(
  bridgeText: string,
  operation: string,
): OutputFieldNode[] {
  try {
    const { document } = parseBridgeDiagnostics(bridgeText);
    const [type, field] = operation.split(".");
    if (!type || !field) return [];

    const bridge = document.instructions.find(
      (i): i is Bridge =>
        i.kind === "bridge" && i.type === type && i.field === field,
    );
    if (!bridge) return [];

    const pathSet = new Set<string>();

    for (const wire of bridge.wires) {
      if (
        wire.to.module === "_" &&
        wire.to.type === type &&
        wire.to.field === field &&
        wire.to.path.length > 0
      ) {
        // Add the full path
        pathSet.add(wire.to.path.join("."));
        // Add all intermediate ancestor paths
        for (let i = 1; i < wire.to.path.length; i++) {
          pathSet.add(wire.to.path.slice(0, i).join("."));
        }
      }
    }

    const allPaths = [...pathSet].sort((a, b) => {
      const aParts = a.split(".");
      const bParts = b.split(".");
      // Sort by depth first, then alphabetically
      for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
        const aP = aParts[i] ?? "";
        const bP = bParts[i] ?? "";
        if (aP !== bP) return aP.localeCompare(bP);
      }
      return aParts.length - bParts.length;
    });

    return allPaths.map((p) => {
      const parts = p.split(".");
      return {
        name: parts[parts.length - 1]!,
        path: p,
        depth: parts.length - 1,
        hasChildren: allPaths.some((other) => other.startsWith(p + ".")),
      };
    });
  } catch {
    return [];
  }
}

/**
 * Extract input field names from a bridge operation and generate a skeleton
 * JSON string with empty-string placeholders.
 *
 * Walks the parsed wires, collects every `from.path` that reads from the
 * bridge's own input (SELF_MODULE, same type/field as the bridge trunk).
 * Builds a nested object with `""` as leaf values.
 *
 * Returns `"{}"` if no input fields are found.
 */
export function extractInputSkeleton(
  bridgeText: string,
  operation: string,
): string {
  try {
    const { document } = parseBridgeDiagnostics(bridgeText);
    const [type, field] = operation.split(".");
    if (!type || !field) return "{}";

    const bridge = document.instructions.find(
      (i): i is Bridge =>
        i.kind === "bridge" && i.type === type && i.field === field,
    );
    if (!bridge) return "{}";

    // Collect all input field paths (from wires that read from the bridge's input).
    // Exclude element wires (from array mappings like `c.field`) which also use
    // SELF_MODULE but have `element: true` — those are tool response fields, not inputs.
    const inputPaths: string[][] = [];
    for (const wire of bridge.wires) {
      if (
        "from" in wire &&
        wire.from.module === "_" &&
        wire.from.type === type &&
        wire.from.field === field &&
        wire.from.path.length > 0 &&
        !wire.from.element
      ) {
        inputPaths.push([...wire.from.path]);
      }
    }

    if (inputPaths.length === 0) return "{}";

    // Build a nested skeleton object
    const skeleton: Record<string, unknown> = {};
    for (const segments of inputPaths) {
      let current: Record<string, unknown> = skeleton;
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i]!;
        if (i === segments.length - 1) {
          // Leaf — only set if not already a deeper object
          if (!(seg in current)) {
            current[seg] = "";
          }
        } else {
          // Intermediate — ensure nested object exists
          if (typeof current[seg] !== "object" || current[seg] === null) {
            current[seg] = {};
          }
          current = current[seg] as Record<string, unknown>;
        }
      }
    }

    return JSON.stringify(skeleton, null, 2);
  } catch {
    return "{}";
  }
}

/**
 * Build a new skeleton and fill in values from the previous JSON where
 * keys match exactly.  Keys that no longer exist in the skeleton are dropped;
 * new skeleton keys get `""` placeholders.
 */
export function mergeInputSkeleton(
  existingJson: string,
  skeletonJson: string,
): string {
  try {
    const existing = JSON.parse(existingJson) as Record<string, unknown>;
    const skeleton = JSON.parse(skeletonJson) as Record<string, unknown>;

    function fill(
      skel: Record<string, unknown>,
      prev: Record<string, unknown>,
    ): Record<string, unknown> {
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(skel)) {
        if (
          key in prev &&
          typeof skel[key] === "object" &&
          skel[key] !== null &&
          !Array.isArray(skel[key]) &&
          typeof prev[key] === "object" &&
          prev[key] !== null &&
          !Array.isArray(prev[key])
        ) {
          result[key] = fill(
            skel[key] as Record<string, unknown>,
            prev[key] as Record<string, unknown>,
          );
        } else if (key in prev) {
          result[key] = prev[key];
        } else {
          result[key] = skel[key];
        }
      }
      return result;
    }

    const merged = fill(skeleton, existing);
    return JSON.stringify(merged, null, 2);
  } catch {
    return skeletonJson;
  }
}

/**
 * Execute a bridge operation standalone — no GraphQL schema, no server.
 *
 * @param bridgeText       Bridge DSL source
 * @param operation        "Type.field" e.g. "Query.searchTrains"
 * @param inputJson        JSON string for input arguments
 * @param requestedFields  Comma-separated output field names (empty = all)
 * @param contextJson      JSON string for context
 */
export async function runBridgeStandalone(
  bridgeText: string,
  operation: string,
  inputJson = "{}",
  requestedFields = "",
  contextJson = "{}",
): Promise<RunResult> {
  // 1. Parse Bridge DSL
  let document;
  try {
    const result = parseBridgeDiagnostics(bridgeText);
    document = result.document;
  } catch (err: unknown) {
    return {
      errors: [
        `Bridge parse error: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  // 2. Parse input JSON
  let input: Record<string, unknown>;
  try {
    input = inputJson.trim()
      ? (JSON.parse(inputJson) as Record<string, unknown>)
      : {};
  } catch (err: unknown) {
    return {
      errors: [
        `Input JSON error: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  // 3. Parse context JSON
  let context: Record<string, unknown>;
  try {
    context = contextJson.trim()
      ? (JSON.parse(contextJson) as Record<string, unknown>)
      : {};
  } catch (err: unknown) {
    return {
      errors: [
        `Context JSON error: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  // 4. Parse requested fields
  const fields = requestedFields
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);

  // 5. Build logger
  const logs: LogEntry[] = [];

  function formatLog(args: unknown[]): string {
    if (args.length === 0) return "";
    const fmt = String(args[0]);
    let i = 1;
    const msg = fmt.replace(/%[sdioOjf%]/g, (token) => {
      if (token === "%%") return "%";
      if (i >= args.length) return token;
      const val = args[i++];
      switch (token) {
        case "%d":
        case "%i":
        case "%f":
          return String(Number(val));
        case "%o":
        case "%O":
        case "%j":
          try {
            return JSON.stringify(val);
          } catch {
            return String(val);
          }
        default:
          return String(val);
      }
    });
    const rest = args.slice(i).map(String);
    return rest.length > 0 ? `${msg} ${rest.join(" ")}` : msg;
  }

  const collectingLogger: Logger = {
    debug: (...args: unknown[]) =>
      logs.push({ level: "debug", message: formatLog(args) }),
    info: (...args: unknown[]) =>
      logs.push({ level: "info", message: formatLog(args) }),
    warn: (...args: unknown[]) =>
      logs.push({ level: "warn", message: formatLog(args) }),
    error: (...args: unknown[]) =>
      logs.push({ level: "error", message: formatLog(args) }),
  };

  // 6. Execute
  _onCacheHit = (key: string) => {
    try {
      const url = new URL(key);
      logs.push({
        level: "info",
        message: `⚡ cache hit: ${url.pathname}${url.search}`,
      });
    } catch {
      logs.push({ level: "info", message: `⚡ cache hit: ${key}` });
    }
  };
  try {
    const result = await executeBridge({
      document,
      operation,
      input,
      tools: { std: { ...std, httpCall: playgroundHttpCall } },
      context,
      trace: "full",
      logger: collectingLogger,
      ...(fields.length > 0 ? { requestedFields: fields } : {}),
    });

    return {
      data: result.data,
      traces: result.traces.length > 0 ? result.traces : undefined,
      logs: logs.length > 0 ? logs : undefined,
    };
  } catch (err: unknown) {
    return {
      errors: [
        `Execution error: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  } finally {
    _onCacheHit = null;
  }
}
