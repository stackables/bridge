/**
 * Browser-side Bridge engine runner.
 *
 * Parses Bridge DSL, applies bridgeTransform to a GraphQL schema built from
 * SDL, and executes a GraphQL query — all in-process with no HTTP server.
 */
import { parseBridgeChevrotain, parseBridgeDiagnostics } from "@stackables/bridge";
import type { BridgeDiagnostic } from "@stackables/bridge";
import { bridgeTransform, builtinTools } from "@stackables/bridge";
import { buildSchema, execute, parse as parseGql } from "graphql";

export type RunResult = {
  data?: unknown;
  errors?: string[];
};

export type DiagnosticResult = {
  diagnostics: BridgeDiagnostic[];
};

/**
 * Parse bridge DSL and return diagnostics (errors / warnings).
 */
export function getDiagnostics(bridgeText: string): DiagnosticResult {
  const result = parseBridgeDiagnostics(bridgeText);
  return { diagnostics: result.diagnostics };
}

/**
 * Execute a GraphQL query against a Bridge-transformed in-memory schema.
 *
 * @param schemaSdl   GraphQL SDL string
 * @param bridgeText  Bridge DSL string
 * @param queryText   GraphQL query string
 * @param variables   Optional query variables
 */
export async function runBridge(
  schemaSdl: string,
  bridgeText: string,
  queryText: string,
  variables: Record<string, unknown> = {},
): Promise<RunResult> {
  // 1. Build GraphQL schema from SDL
  let schema;
  try {
    schema = buildSchema(schemaSdl);
  } catch (err: unknown) {
    return { errors: [`Schema error: ${err instanceof Error ? err.message : String(err)}`] };
  }

  // 2. Parse Bridge DSL
  let instructions;
  try {
    instructions = parseBridgeChevrotain(bridgeText);
  } catch (err: unknown) {
    return { errors: [`Bridge parse error: ${err instanceof Error ? err.message : String(err)}`] };
  }

  // 3. Apply bridge transform
  let transformedSchema;
  try {
    transformedSchema = bridgeTransform(schema, instructions, {
      tools: builtinTools,
    });
  } catch (err: unknown) {
    return { errors: [`Transform error: ${err instanceof Error ? err.message : String(err)}`] };
  }

  // 4. Parse GQL query
  let document;
  try {
    document = parseGql(queryText);
  } catch (err: unknown) {
    return { errors: [`Query parse error: ${err instanceof Error ? err.message : String(err)}`] };
  }

  // 5. Execute
  try {
    const result = await execute({
      schema: transformedSchema,
      document,
      variableValues: variables,
    });

    const errors = result.errors?.map((e) => {
      const path = e.path ? ` (path: ${e.path.join(".")})` : "";
      return `${e.message}${path}`;
    });
    return { data: result.data, errors };
  } catch (err: unknown) {
    return { errors: [`Execution error: ${err instanceof Error ? err.message : String(err)}`] };
  }
}
