/**
 * @stackables/bridge-graphql — Wire bridges into a GraphQL schema.
 *
 * Provides `bridgeTransform()` to map bridge instructions onto GraphQL
 * resolvers, plus tracing utilities for request-level tool-call visibility.
 *
 * Peer dependencies: `graphql`, `@graphql-tools/utils`.
 */

export {
  bridgeTransform,
  getBridgeTraces,
  useBridgeTracing,
  BridgeGraphQLIncompatibleError,
} from "./bridge-transform.ts";
export type { BridgeOptions, DocumentSource } from "./bridge-transform.ts";
