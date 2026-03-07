import { MapperKind, mapSchema } from "@graphql-tools/utils";
import {
  GraphQLList,
  GraphQLNonNull,
  type GraphQLSchema,
  type GraphQLResolveInfo,
  type SelectionNode,
  Kind,
  defaultFieldResolver,
  getNamedType,
  isScalarType,
} from "graphql";
import {
  ExecutionTree,
  TraceCollector,
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
import { SELF_MODULE } from "@stackables/bridge-core";
import {
  assertBridgeGraphQLCompatible,
  BridgeGraphQLIncompatibleError,
} from "./bridge-asserts.ts";

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
   * Override the standalone execution function.
   *
   * When provided, **all** bridge operations are executed through this function
   * instead of the field-by-field GraphQL resolver. Operations that are
   * incompatible with GraphQL execution (e.g. nested multilevel `break` /
   * `continue`) also use this function as an automatic fallback.
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
  // When an explicit executeBridge is provided, all operations use standalone mode.
  const forceStandalone = !!options?.executeBridge;

  // Cache for standalone-op detection on dynamic documents (keyed by doc instance).
  const standaloneOpsCache = new WeakMap<BridgeDocument, Set<string>>();

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

      // For static documents (or forceStandalone), the standalone decision is fully
      // known at setup time — precompute it as a plain boolean so the resolver just
      // reads a variable. For dynamic documents (document is a function) the actual
      // doc instance isn't available until request time; detectForDynamic() handles
      // that path with a per-doc-instance WeakMap cache.
      function precomputeStandalone() {
        if (forceStandalone) return true;
        if (typeof document === "function") return null; // deferred to request time
        const bridge = document.instructions.find(
          (i) =>
            i.kind === "bridge" &&
            (i as Bridge).type === typeName &&
            (i as Bridge).field === fieldName,
        ) as Bridge | undefined;
        if (!bridge) return false;
        try {
          assertBridgeGraphQLCompatible(bridge);
          return false;
        } catch (e) {
          if (e instanceof BridgeGraphQLIncompatibleError) {
            logger.warn?.(
              `${e.message} ` +
                `Falling back to standalone execution mode. ` +
                `In standalone mode errors affect the entire field result ` +
                `rather than individual sub-fields.`,
            );
            return true;
          }
          throw e;
        }
      }

      // Only used for dynamic documents (standalonePrecomputed === null).
      function detectForDynamic(doc: BridgeDocument): boolean {
        let ops = standaloneOpsCache.get(doc);
        if (!ops) {
          ops = new Set<string>();
          for (const instr of doc.instructions) {
            if (instr.kind !== "bridge") continue;
            try {
              assertBridgeGraphQLCompatible(instr as Bridge);
            } catch (e) {
              if (e instanceof BridgeGraphQLIncompatibleError) {
                ops.add(e.operation);
                logger.warn?.(
                  `${e.message} ` +
                    `Falling back to standalone execution mode. ` +
                    `In standalone mode errors affect the entire field result ` +
                    `rather than individual sub-fields.`,
                );
              } else {
                throw e;
              }
            }
          }
          standaloneOpsCache.set(doc, ops);
        }
        return ops.has(`${typeName}.${fieldName}`);
      }

      // Standalone execution: runs the full bridge through executeBridge and
      // returns the resolved data directly. GraphQL sub-field resolvers receive
      // plain objects and fall through to the default field resolver.
      // All errors surface as a single top-level field error rather than
      // per-sub-field GraphQL errors.
      async function resolveAsStandalone(
        activeDoc: BridgeDocument,
        bridgeContext: Record<string, unknown>,
        args: Record<string, unknown>,
        context: any,
        info: GraphQLResolveInfo,
      ): Promise<unknown> {
        const requestedFields = collectRequestedFields(info);
        try {
          const { data, traces } = await executeBridgeFn({
            document: activeDoc,
            operation: `${typeName}.${fieldName}`,
            input: args,
            context: bridgeContext,
            tools: userTools,
            ...(traceLevel !== "off" ? { trace: traceLevel } : {}),
            logger,
            ...(options?.toolTimeoutMs !== undefined
              ? { toolTimeoutMs: options.toolTimeoutMs }
              : {}),
            ...(options?.maxDepth !== undefined
              ? { maxDepth: options.maxDepth }
              : {}),
            ...(requestedFields.length > 0 ? { requestedFields } : {}),
          });
          if (traceLevel !== "off") {
            context.__bridgeTracer = { traces };
          }
          return data;
        } catch (err) {
          throw new Error(formatBridgeError(err), { cause: err });
        }
      }

      const standalonePrecomputed = precomputeStandalone();

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

            // Standalone execution path — used when the operation is incompatible
            // with field-by-field GraphQL resolution, or when an explicit
            // executeBridge override has been provided.
            if (standalonePrecomputed ?? detectForDynamic(activeDoc)) {
              return resolveAsStandalone(
                activeDoc,
                bridgeContext,
                args ?? {},
                context,
                info,
              );
            }

            // GraphQL field-by-field execution path via ExecutionTree.
            source = new ExecutionTree(
              trunk,
              activeDoc,
              allTools,
              bridgeContext,
            );

            source.logger = logger;
            source.source = activeDoc.source;
            source.filename = activeDoc.filename;
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
            let result;
            try {
              result = await source.response(info.path, array);
            } catch (err) {
              throw new Error(formatBridgeError(err), { cause: err });
            }

            // Scalar return types (JSON, JSONObject, etc.) won't trigger
            // sub-field resolvers, so if response() deferred resolution by
            // returning the tree itself, eagerly materialise the output.
            if (scalar) {
              if (result instanceof ExecutionTree) {
                try {
                  return result.collectOutput();
                } catch (err) {
                  throw new Error(formatBridgeError(err), { cause: err });
                }
              }
              if (Array.isArray(result) && result[0] instanceof ExecutionTree) {
                try {
                  return await Promise.all(
                    result.map((shadow: ExecutionTree) =>
                      shadow.collectOutput(),
                    ),
                  );
                } catch (err) {
                  throw new Error(formatBridgeError(err), { cause: err });
                }
              }
            }

            // At the leaf level (not root), race data pull with critical
            // force promises so errors propagate into GraphQL `errors[]`
            // while still allowing parallel execution.
            if (info.path.prev && source.getForcedExecution()) {
              try {
                return await Promise.all([
                  result,
                  source.getForcedExecution(),
                ]).then(([data]) => data);
              } catch (err) {
                throw new Error(formatBridgeError(err), { cause: err });
              }
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
