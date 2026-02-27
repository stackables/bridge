/**
 * Bridge GraphQL Adapter — wire bridges into a GraphQL schema.
 *
 * Provides `bridgeTransform()` to map bridge instructions onto GraphQL
 * resolvers, plus tracing utilities for request-level tool-call visibility.
 *
 * Peer dependencies: `graphql`, `@graphql-tools/utils`.
 *
 * ```ts
 * import { bridgeTransform, useBridgeTracing } from "@stackables/bridge/graphql";
 * ```
 */

export {
  bridgeTransform,
  getBridgeTraces,
  useBridgeTracing,
} from "./bridge-transform.ts";
export type { BridgeOptions, InstructionSource } from "./bridge-transform.ts";
