import { MapperKind, mapSchema } from "@graphql-tools/utils";
import {
  type GraphQLSchema,
  type GraphQLResolveInfo,
  type SelectionNode,
  Kind,
  defaultFieldResolver,
  getNamedType,
  isObjectType,
} from "graphql";
import {
  executeBridge as executeBridgeDefault,
  formatBridgeError,
  resolveStd,
  checkHandleVersions,
  type Logger,
  type ToolTrace,
  type TraceLevel,
  type ExecuteBridgeOptions,
  type ExecuteBridgeResult,
} from "@stackables/bridge-core";
import {
  std as bundledStd,
  STD_VERSION as BUNDLED_STD_VERSION,
} from "@stackables/bridge-stdlib";
import type { Bridge, BridgeDocument, ToolMap } from "@stackables/bridge-core";

export type { Logger };
export { BridgeGraphQLIncompatibleError } from "./bridge-asserts.ts";

/**
 * Extract leaf-level field paths from a GraphQL resolve info's selection set.
 * Used to build requestedFields for standalone executeBridge calls.
 */
function collectRequestedFields(info: GraphQLResolveInfo): string[] {
  const paths: string[] = [];
  function walk(selections: readonly SelectionNode[], prefix: string): void {
    for (const sel of selections) {
      if (sel.kind === Kind.FIELD) {
        const name = sel.name.value;
        if (name.startsWith("__")) continue;
        const path = prefix ? `${prefix}.${name}` : name;
        if (sel.selectionSet) {
          walk(sel.selectionSet.selections, path);
        } else {
          paths.push(path);
        }
      } else if (sel.kind === Kind.INLINE_FRAGMENT) {
        walk(sel.selectionSet.selections, prefix);
      } else if (sel.kind === Kind.FRAGMENT_SPREAD) {
        const frag = info.fragments[sel.name.value];
        if (frag) walk(frag.selectionSet.selections, prefix);
      }
    }
  }
  const fieldNode = info.fieldNodes[0];
  if (fieldNode?.selectionSet) {
    walk(fieldNode.selectionSet.selections, "");
  }
  return paths;
}

/**
 * Recursively scan a value for Error Sentinel objects planted by the engine.
 * Returns the first Error found, or null if none.
 */
function findErrorSentinel(data: unknown): Error | null {
  if (data instanceof Error) return data;
  if (data != null && typeof data === "object" && !Array.isArray(data)) {
    for (const v of Object.values(data)) {
      const found = findErrorSentinel(v);
      if (found) return found;
    }
  }
  return null;
}

const noop = () => {};
const defaultLogger: Logger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
};

export type BridgeOptions = {
  /**
   * Tool functions available to the engine.
   * Supports namespaced nesting: `{ myNamespace: { myTool } }`.
   * The built-in `std` namespace is always included; user tools are
   * merged on top (shallow).
   *
   * To provide a specific version of std (e.g. when bridge files
   * target an older major), use a versioned namespace key:
   * ```ts
   * tools: { "std@1.5": oldStdNamespace }
   * ```
   */
  tools?: ToolMap;
  /** Optional function to reshape/restrict the GQL context before it reaches bridge files.
   *  By default the full context is exposed via `with context`. */
  contextMapper?: (context: any) => Record<string, any>;
  /** Enable tool-call tracing.
   *  - `"off"` (default) — no collection, zero overhead
   *  - `"basic"` — tool, fn, timing, errors; no input/output
   *  - `"full"` — everything including input and output */
  trace?: TraceLevel;
  /**
   * Structured logger for engine-level events (tool errors, warnings, debug).
   * Accepts any logger with `debug`, `info`, `warn`, and `error` methods —
   * pino, winston, `console`, or any compatible interface.
   * Defaults to silent no-ops so there is zero output unless you opt in.
   */
  logger?: Logger;
  /**
   * Hard timeout for tool calls in milliseconds.
   * Tools that exceed this duration throw a `BridgeTimeoutError`.
   * Default: 15_000 (15 seconds). Set to `0` to disable.
   */
  toolTimeoutMs?: number;
  /**
   * Maximum shadow-tree nesting depth.
   * Default: 30. Increase for deeply nested array mappings.
   */
  maxDepth?: number;
  /**
   * Extract a per-request `AbortSignal` from the GraphQL context.
   * When the signal is aborted, in-flight tool calls throw `BridgeAbortError`.
   *
   * Typical usage with GraphQL Yoga:
   * ```ts
   * bridgeTransform(schema, doc, {
   *   signalMapper: (context) => context.request?.signal,
   * })
   * ```
   */
  signalMapper?: (context: any) => AbortSignal | undefined;
  /**
   * Override the execution function.
   *
   * This allows plugging in the AOT compiler as the execution engine:
   * ```ts
   * import { executeBridge } from "@stackables/bridge-compiler";
   * bridgeTransform(schema, doc, { executeBridge })
   * ```
   * Defaults to the interpreter `executeBridge` from `@stackables/bridge-core`.
   */
  executeBridge?: (
    options: ExecuteBridgeOptions,
  ) => Promise<ExecuteBridgeResult>;
  /**
   * Enable partial success (Error Sentinels).
   *
   * When `true`, non-fatal errors on individual output fields are delivered as
   * per-field GraphQL errors while sibling fields still resolve successfully.
   * The affected field becomes `null` and an entry appears in the `errors` array.
   *
   * When `false` (default), any error causes the entire root field to fail.
   */
  partialSuccess?: boolean;
};

/** Document can be a static BridgeDocument or a function that selects per-request */
export type DocumentSource =
  | BridgeDocument
  | ((context: any) => BridgeDocument);

export function bridgeTransform(
  schema: GraphQLSchema,
  document: DocumentSource,
  options?: BridgeOptions,
): GraphQLSchema {
  const userTools = options?.tools ?? {};
  const contextMapper = options?.contextMapper;
  const traceLevel = options?.trace ?? "off";
  const logger = options?.logger ?? defaultLogger;
  const executeBridgeFn = options?.executeBridge ?? executeBridgeDefault;
  const partialSuccess = options?.partialSuccess ?? false;

  // Detect actual root type names from the schema (handles custom root types
  // like `schema { query: Chained }` in addition to the standard names).
  const rootTypeNames = new Set<string>(
    [
      schema.getQueryType()?.name,
      schema.getMutationType()?.name,
      schema.getSubscriptionType()?.name,
    ].filter((n): n is string => n != null),
  );

  return mapSchema(schema, {
    [MapperKind.OBJECT_FIELD]: (fieldConfig, fieldName, typeName) => {
      const { resolve = defaultFieldResolver } = fieldConfig;
      const isRoot = rootTypeNames.has(typeName);

      return {
        ...fieldConfig,
        resolve: async function (source, args, context: any, info) {
          // Sub-field: intercept Error Sentinels planted by the bridge engine
          // (only active when partialSuccess is enabled — sentinels are only
          // planted when the engine was called with partialSuccess: true)
          if (partialSuccess && source !== undefined) {
            const value = (source as Record<string, unknown>)[info.fieldName];
            if (value instanceof Error) throw value;
          }

          // Non-root fields: delegate to the original resolver so that
          // hand-coded sub-field resolvers are preserved and not overwritten.
          if (!isRoot || source !== undefined) {
            return resolve(source, args, context, info);
          }

          // Root bridge field: run holistic standalone execution
          const activeDoc =
            typeof document === "function" ? document(context) : document;

          // Only intercept fields that have a matching bridge instruction.
          // Fields without one fall through to the original resolver.
          const hasBridge = activeDoc.instructions.some(
            (i) =>
              i.kind === "bridge" &&
              (i as Bridge).type === typeName &&
              (i as Bridge).field === fieldName,
          );
          if (!hasBridge) return resolve(source, args, context, info);

          const { namespace: activeStd, version: activeStdVersion } =
            resolveStd(
              activeDoc.version,
              bundledStd,
              BUNDLED_STD_VERSION,
              userTools,
            );
          const allTools: ToolMap = { std: activeStd, ...userTools };
          checkHandleVersions(
            activeDoc.instructions,
            allTools,
            activeStdVersion,
          );

          const bridgeContext = contextMapper
            ? contextMapper(context)
            : (context ?? {});
          const requestedFields = collectRequestedFields(info);
          const signal = options?.signalMapper?.(context);

          try {
            const { data, traces } = await executeBridgeFn({
              document: activeDoc,
              operation: `${typeName}.${fieldName}`,
              input: args ?? {},
              context: bridgeContext,
              tools: userTools,
              ...(traceLevel !== "off" ? { trace: traceLevel } : {}),
              logger,
              ...(signal ? { signal } : {}),
              ...(options?.toolTimeoutMs !== undefined
                ? { toolTimeoutMs: options.toolTimeoutMs }
                : {}),
              ...(options?.maxDepth !== undefined
                ? { maxDepth: options.maxDepth }
                : {}),
              ...(requestedFields.length > 0 ? { requestedFields } : {}),
              partialSuccess,
            });
            if (traceLevel !== "off") context.__bridgeTracer = { traces };
            // When partialSuccess is enabled and the return type is a scalar
            // (e.g. JSONObject fallback), sub-field resolvers won't fire to
            // re-throw Error Sentinels. Scan the data and surface the first
            // one found as a root-field error so it reaches result.errors.
            if (partialSuccess) {
              const namedReturnType = getNamedType(info.returnType);
              if (!isObjectType(namedReturnType)) {
                const sentinel = findErrorSentinel(data);
                if (sentinel) throw sentinel;
              }
            }
            return data;
          } catch (err) {
            // Capture traces from the error before rethrowing so tracing
            // plugins can still read them even when execution fails.
            if (traceLevel !== "off") {
              const errTraces = (err as { traces?: ToolTrace[] })?.traces;
              if (errTraces) context.__bridgeTracer = { traces: errTraces };
            }
            throw new Error(
              formatBridgeError(err, {
                source: activeDoc.source,
                filename: activeDoc.filename,
              }),
              { cause: err },
            );
          }
        },
      };
    },
  });
}

/**
 * Read traces that were collected during the current request.
 * Pass the GraphQL context object; returns an empty array when tracing is
 * disabled or no traces were recorded.
 */
export function getBridgeTraces(context: any): ToolTrace[] {
  return (
    (context?.__bridgeTracer as { traces: ToolTrace[] } | undefined)?.traces ??
    []
  );
}

/**
 * Envelop-compatible plugin for GraphQL Yoga (or any Envelop-based server).
 * When bridge tracing is enabled, this plugin copies the recorded traces into
 * the GraphQL response `extensions.traces` field.
 *
 * Usage:
 * ```ts
 * createYoga({ schema, plugins: [useBridgeTracing()] })
 * ```
 */
export function useBridgeTracing() {
  return {
    onExecute({ args }: { args: { contextValue: any } }) {
      return {
        onExecuteDone({
          result,
          setResult,
        }: {
          result: any;
          setResult: (r: any) => void;
        }) {
          const traces = getBridgeTraces(args.contextValue);
          if (traces.length > 0 && result && "data" in result) {
            setResult({
              ...result,
              extensions: {
                ...(result.extensions ?? {}),
                traces,
              },
            });
          }
        },
      };
    },
  };
}
