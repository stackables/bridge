import { MapperKind, mapSchema } from "@graphql-tools/utils";
import {
  GraphQLList,
  GraphQLNonNull,
  type GraphQLSchema,
  defaultFieldResolver,
  getNamedType,
  isScalarType,
} from "graphql";
import {
  ExecutionTree,
  TraceCollector,
  resolveStd,
  checkHandleVersions,
  type Logger,
  type ToolTrace,
  type TraceLevel,
} from "@stackables/bridge-core";
import {
  std as bundledStd,
  STD_VERSION as BUNDLED_STD_VERSION,
} from "@stackables/bridge-stdlib";
import type { Bridge, BridgeDocument, ToolMap } from "@stackables/bridge-core";
import { SELF_MODULE } from "@stackables/bridge-core";

export type { Logger };

/**
 * Detect whether a bridge uses multilevel break/continue (levels > 1) inside
 * a nested array element wire (to.path.length > 1 && to.element === true).
 *
 * The GraphQL runtime resolves arrays field-by-field via resolver callbacks.
 * This means a LoopControlSignal emitted deep inside an element field cannot
 * propagate back out to the already-committed outer shadow array — the signal
 * would simply be returned as a raw field value, silently producing wrong output.
 *
 * This pattern is only supported in standalone execution mode
 * (`executeBridge` / `@stackables/bridge-core`).
 */
function assertNoNestedMultilevelControlFlow(doc: BridgeDocument): void {
  for (const instr of doc.instructions) {
    if (instr.kind !== "bridge") continue;
    const bridge = instr as Bridge;
    for (const wire of bridge.wires) {
      if (wire.to.path.length <= 1) continue;
      const fallbacks =
        "from" in wire
          ? wire.fallbacks
          : "cond" in wire
            ? wire.fallbacks
            : "condAnd" in wire
              ? wire.fallbacks
              : "condOr" in wire
                ? wire.fallbacks
                : undefined;
      const hasMultilevelFallback = fallbacks?.some(
        (fb) =>
          fb.control &&
          (fb.control.kind === "break" || fb.control.kind === "continue") &&
          (fb.control.levels ?? 1) > 1,
      );
      const catchControl =
        "from" in wire
          ? wire.catchControl
          : "cond" in wire
            ? wire.catchControl
            : "condAnd" in wire
              ? wire.catchControl
              : "condOr" in wire
                ? wire.catchControl
                : undefined;
      const hasMultilevelCatch =
        catchControl &&
        (catchControl.kind === "break" || catchControl.kind === "continue") &&
        (catchControl.levels ?? 1) > 1;
      if (hasMultilevelFallback || hasMultilevelCatch) {
        const loc = `${bridge.type}.${bridge.field}`;
        const path = wire.to.path.join(".");
        throw new Error(
          `[bridge] ${loc}: 'break N' / 'continue N' with N > 1 inside a nested ` +
            `array element (path: ${path}) is not supported in GraphQL execution mode. ` +
            `Use standalone execution (executeBridge) instead, or restructure to ` +
            `use single-level break/continue and filter at the outer loop.`,
        );
      }
    }
  }
}

export type { Logger };

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

  // Static documents are validated at setup time to catch unsupported patterns
  // early instead of producing silent wrong output at runtime.
  if (typeof document !== "function") {
    assertNoNestedMultilevelControlFlow(document);
  }
  const logger = options?.logger ?? defaultLogger;

  return mapSchema(schema, {
    [MapperKind.OBJECT_FIELD]: (fieldConfig, fieldName, typeName) => {
      let array = false;
      if (fieldConfig.type instanceof GraphQLNonNull) {
        if (fieldConfig.type.ofType instanceof GraphQLList) {
          array = true;
        }
      }
      if (fieldConfig.type instanceof GraphQLList) {
        array = true;
      }

      // Detect scalar return types (e.g. JSON, JSONObject) — GraphQL won't
      // call sub-field resolvers for scalars, so the engine must eagerly
      // materialise the full output object instead of returning itself.
      const scalar = isScalarType(getNamedType(fieldConfig.type));

      const trunk = { module: SELF_MODULE, type: typeName, field: fieldName };
      const { resolve = defaultFieldResolver } = fieldConfig;

      return {
        ...fieldConfig,
        resolve: async function (
          source: ExecutionTree | undefined,
          args,
          context: any,
          info,
        ) {
          // Start execution tree at query/mutation root
          if (!source && !info.path.prev) {
            const activeDoc =
              typeof document === "function" ? document(context) : document;

            // Resolve which std to use: bundled, or a versioned namespace from tools
            const { namespace: activeStd, version: activeStdVersion } =
              resolveStd(
                activeDoc.version,
                bundledStd,
                BUNDLED_STD_VERSION,
                userTools,
              );

            // std is always included; user tools merge on top (shallow)
            // internal tools are injected automatically by ExecutionTree
            const allTools: ToolMap = {
              std: activeStd,
              ...userTools,
            };

            // Verify all @version-tagged handles can be satisfied
            checkHandleVersions(
              activeDoc.instructions,
              allTools,
              activeStdVersion,
            );

            // Only intercept fields that have a matching bridge instruction.
            // Fields without one fall through to their original resolver,
            // allowing hand-coded resolvers to coexist with bridge-powered ones.
            const hasBridge = activeDoc.instructions.some(
              (i) =>
                i.kind === "bridge" &&
                i.type === typeName &&
                i.field === fieldName,
            );
            if (!hasBridge) {
              return resolve(source, args, context, info);
            }

            const bridgeContext = contextMapper
              ? contextMapper(context)
              : (context ?? {});

            source = new ExecutionTree(
              trunk,
              activeDoc,
              allTools,
              bridgeContext,
            );

            source.logger = logger;
            if (
              options?.toolTimeoutMs !== undefined &&
              Number.isFinite(options.toolTimeoutMs) &&
              options.toolTimeoutMs >= 0
            ) {
              source.toolTimeoutMs = Math.floor(options.toolTimeoutMs);
            }
            if (
              options?.maxDepth !== undefined &&
              Number.isFinite(options.maxDepth) &&
              options.maxDepth >= 0
            ) {
              source.maxDepth = Math.floor(options.maxDepth);
            }

            if (traceLevel !== "off") {
              source.tracer = new TraceCollector(traceLevel);
              // Stash tracer on GQL context so the tracing plugin can read it
              context.__bridgeTracer = source.tracer;
            }
          }

          if (
            source instanceof ExecutionTree &&
            args &&
            Object.keys(args).length > 0
          ) {
            source.push(args);
          }

          // Kick off forced handles (force <handle>) at the root entry point
          if (source instanceof ExecutionTree && !info.path.prev) {
            // Ensure input state exists even with no args (prevents
            // recursive scheduling of the input trunk → stack overflow).
            if (!args || Object.keys(args).length === 0) {
              source.push({});
            }
            const criticalForces = source.executeForced();
            if (criticalForces.length > 0) {
              source.setForcedExecution(
                Promise.all(criticalForces).then(() => {}),
              );
            }
          }

          if (source instanceof ExecutionTree) {
            const result = await source.response(info.path, array);

            // Scalar return types (JSON, JSONObject, etc.) won't trigger
            // sub-field resolvers, so if response() deferred resolution by
            // returning the tree itself, eagerly materialise the output.
            if (scalar) {
              if (result instanceof ExecutionTree) {
                return result.collectOutput();
              }
              if (Array.isArray(result) && result[0] instanceof ExecutionTree) {
                return Promise.all(
                  result.map((shadow: ExecutionTree) => shadow.collectOutput()),
                );
              }
            }

            // At the leaf level (not root), race data pull with critical
            // force promises so errors propagate into GraphQL `errors[]`
            // while still allowing parallel execution.
            if (info.path.prev && source.getForcedExecution()) {
              return Promise.all([result, source.getForcedExecution()]).then(
                ([data]) => data,
              );
            }
            return result;
          }

          return resolve(source, args, context, info);
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
  return (context?.__bridgeTracer as TraceCollector | undefined)?.traces ?? [];
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
