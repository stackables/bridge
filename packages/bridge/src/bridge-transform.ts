import { MapperKind, mapSchema } from "@graphql-tools/utils";
import {
  GraphQLList,
  GraphQLNonNull,
  type GraphQLSchema,
  defaultFieldResolver,
} from "graphql";
import { ExecutionTree } from "./ExecutionTree.js";
import { builtinTools } from "./tools/index.js";
import type { Instruction, ToolCallFn, ToolMap } from "./types.js";
import { SELF_MODULE } from "./types.js";

export type BridgeOptions = {
  /** Tool functions available to the engine.
   *  Supports namespaced nesting: `{ myNamespace: { myTool } }`.
   *  The built-in `std` namespace and `httpCall` are always included;
   *  user tools are merged on top (shallow). */
  tools?: ToolMap;
  /** Optional function to reshape/restrict the GQL context before it reaches bridge files.
   *  By default the full context is exposed via `with context`. */
  contextMapper?: (context: any) => Record<string, any>;
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
            const bridgeContext = contextMapper
              ? contextMapper(context)
              : (context ?? {});

            const activeInstructions =
              typeof instructions === "function"
                ? instructions(context)
                : instructions;

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
