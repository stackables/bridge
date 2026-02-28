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
      logger: options?.logger,
    }),
    plugins: tracing !== "off" ? [useBridgeTracing()] : [],
    context: () => ({
      ...(options?.context ?? {}),
    }),
    graphqlEndpoint: "*",
  });
}
