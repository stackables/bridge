/**
 * Browser-side Bridge engine runner.
 *
 * Parses Bridge DSL, applies bridgeTransform to a GraphQL schema built from
 * SDL, and executes a GraphQL query — all in-process with no HTTP server.
 */
import {
  parseBridgeChevrotain,
  parseBridgeDiagnostics,
} from "@stackables/bridge";
import type {
  BridgeDiagnostic,
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
