import { MapperKind, mapSchema } from "@graphql-tools/utils";
import {
  GraphQLList,
  GraphQLNonNull,
  type GraphQLSchema,
  defaultFieldResolver,
} from "graphql";
import { ExecutionTree } from "./ExecutionTree.js";
import { createHttpCall } from "./http-executor.js";
import type { Instruction, ToolCallFn } from "./types.js";
import { SELF_MODULE } from "./types.js";

export type BridgeOptions = {
  /** Tool functions available to the engine (e.g. { httpCall, centsToUsd, "hereapi.geocode": fn }) */
  tools?: Record<string, ToolCallFn | ((...args: any[]) => any)>;
  /** Context key to read config from (default: "config") */
  configKey?: string;
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
  const configKey = options?.configKey ?? "config";

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
            const config = context?.[configKey] ?? {};

            const activeInstructions =
              typeof instructions === "function"
                ? instructions(context)
                : instructions;

            // Built-in tools + user tools (user can override built-ins)
            const allTools: Record<
              string,
              ToolCallFn | ((...args: any[]) => any)
            > = {
              httpCall: createHttpCall(),
              ...userTools,
            };

            source = new ExecutionTree(
              trunk,
              activeInstructions,
              allTools,
              config,
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
