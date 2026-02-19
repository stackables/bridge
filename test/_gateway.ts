import { createSchema, createYoga } from "graphql-yoga";
import type { InstructionSource } from "../src/bridge-transform.js";
import { bridgeTransform } from "../src/bridge-transform.js";
import type { ToolCallFn } from "../src/types.js";

type GatewayOptions = {
  context?: Record<string, any>;
  tools?: Record<string, ToolCallFn | ((...args: any[]) => any)>;
};

export function createGateway(
  typeDefs: string,
  instructions: InstructionSource,
  options?: GatewayOptions,
) {
  const schema = createSchema({ typeDefs });

  return createYoga({
    schema: bridgeTransform(schema, instructions, {
      tools: options?.tools,
    }),
    context: () => ({
      ...(options?.context ?? {}),
    }),
    graphqlEndpoint: "*",
  });
}
