import { MapperKind, mapSchema } from "@graphql-tools/utils";
import {
  GraphQLList,
  GraphQLNonNull,
  type GraphQLSchema,
  defaultFieldResolver,
} from "graphql";
import { ExecutionTree, TraceCollector, type Logger, type ToolTrace, type TraceLevel } from "./ExecutionTree.js";
import { builtinTools } from "./tools/index.js";
import type { Instruction, ToolMap } from "./types.js";
import { SELF_MODULE } from "./types.js";

export type { Logger };

const noop = () => {};
const defaultLogger: Logger = { debug: noop, info: noop, warn: noop, error: noop };

export type BridgeOptions = {
  /** Tool functions available to the engine.
   *  Supports namespaced nesting: `{ myNamespace: { myTool } }`.
   *  The built-in `std` namespace and `httpCall` are always included;
   *  user tools are merged on top (shallow). */
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
};

/** Instructions can be a static array or a function that selects per-request */
export type InstructionSource =
  | Instruction[]
  | ((context: any) => Instruction[]);

export function bridgeTransform(
  schema: GraphQLSchema,
  instructions: InstructionSource,
  options?: BridgeOptions,
): GraphQLSchema {
  const userTools = options?.tools;
  const contextMapper = options?.contextMapper;
  const traceLevel = options?.trace ?? "off";
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
            const activeInstructions =
              typeof instructions === "function"
                ? instructions(context)
                : instructions;

            // Only intercept fields that have a matching bridge instruction.
            // Fields without one fall through to their original resolver,
            // allowing hand-coded resolvers to coexist with bridge-powered ones.
            const hasBridge = activeInstructions.some(
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

            // Always include builtinTools; user tools merge on top (shallow)
            const allTools: ToolMap = {
              ...builtinTools,
              ...(userTools ?? {}),
            };

            source = new ExecutionTree(
              trunk,
              activeInstructions,
              allTools,
              bridgeContext,
            );

            source.logger = logger;

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

          // Kick off forced wires (<-!) at the root entry point
          if (source instanceof ExecutionTree && !info.path.prev) {
            // Ensure input state exists even with no args (prevents
            // recursive scheduling of the input trunk → stack overflow).
            if (!args || Object.keys(args).length === 0) {
              source.push({});
            }
            source.executeForced();
          }

          if (source instanceof ExecutionTree) {
            return source.response(info.path, array);
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
