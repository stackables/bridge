import { createSchema, createYoga } from "graphql-yoga";
import type { DocumentSource } from "../src/index.ts";
import { bridgeTransform, useBridgeTracing } from "../src/index.ts";
import type { ToolMap } from "../src/index.ts";
import type { Logger, TraceLevel } from "../src/index.ts";

type GatewayOptions = {
  context?: Record<string, any>;
  tools?: ToolMap;
  /** Enable tool-call tracing — `"basic"` for timings only, `"full"` for everything, `"off"` to disable (default) */
  trace?: TraceLevel;
  /** Capture traversal ids and expose them in GraphQL extensions. */
  traversalId?: boolean;
  /** Structured logger passed to the engine (and to tools via ToolContext) */
  logger?: Logger;
};

export function createGateway(
  typeDefs: string,
  document: DocumentSource,
  options?: GatewayOptions,
) {
  const schema = createSchema({ typeDefs });
  const tracing = options?.trace ?? "off";

  return createYoga({
    schema: bridgeTransform(schema, document, {
      tools: options?.tools,
      trace: tracing,
      traversalId: options?.traversalId,
      logger: options?.logger,
    }),
    plugins:
      tracing !== "off" || options?.traversalId ? [useBridgeTracing()] : [],
    context: () => ({
      ...(options?.context ?? {}),
    }),
    graphqlEndpoint: "*",
  });
}
