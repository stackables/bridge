import { createSchema, createYoga } from "graphql-yoga";
import type { InstructionSource } from "../src/bridge-transform.js";
import { bridgeTransform, useBridgeTracing } from "../src/bridge-transform.js";
import type { ToolMap } from "../src/types.js";
import type { TraceLevel } from "../src/ExecutionTree.js";

type GatewayOptions = {
  context?: Record<string, any>;
  tools?: ToolMap;
  /** Enable tool-call tracing — `"basic"` for timings only, `"full"` for everything, `"off"` to disable (default) */
  trace?: TraceLevel;
};

export function createGateway(
  typeDefs: string,
  instructions: InstructionSource,
  options?: GatewayOptions,
) {
  const schema = createSchema({ typeDefs });
  const tracing = options?.trace ?? "off";

  return createYoga({
    schema: bridgeTransform(schema, instructions, {
      tools: options?.tools,
      trace: tracing,
    }),
    plugins: tracing !== "off" ? [useBridgeTracing()] : [],
    context: () => ({
      ...(options?.context ?? {}),
    }),
    graphqlEndpoint: "*",
  });
}
