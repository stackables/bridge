import { createSchema, createYoga } from "graphql-yoga";
import type { InstructionSource } from "../src/bridge-transform.js";
import { bridgeTransform, useBridgeTracing } from "../src/bridge-transform.js";
import type { ToolMap } from "../src/types.js";
import type { TraceLevel } from "../src/ExecutionTree.js";

type GatewayOptions = {
  context?: Record<string, any>;
  tools?: ToolMap;
  /** Enable tool-call tracing — `true`/`"full"` for everything, `"basic"` for timings only */
  trace?: boolean | TraceLevel;
};

export function createGateway(
  typeDefs: string,
  instructions: InstructionSource,
  options?: GatewayOptions,
) {
  const schema = createSchema({ typeDefs });
  const tracing = options?.trace ?? false;

  return createYoga({
    schema: bridgeTransform(schema, instructions, {
      tools: options?.tools,
      trace: tracing,
    }),
    plugins: tracing ? [useBridgeTracing()] : [],
    context: () => ({
      ...(options?.context ?? {}),
    }),
    graphqlEndpoint: "*",
  });
}
