import { prettyPrintToSource } from "../src/index.ts";

/**
 * Formatter unit tests include partial snippets (for spacing/line-shaping cases)
 * that are intentionally not valid full Bridge documents.
 *
 * `prettyPrintToSource` supports a pre-validated CST input to skip strict parsing.
 * The pretty-printer itself is token-based and does not read CST structure.
 */
type PrevalidatedInput = Exclude<Parameters<typeof prettyPrintToSource>[0], string>;
// Intentionally a placeholder: formatter behavior under test is token-based and
// does not inspect CST contents when a pre-validated CST is provided.
const TEST_ONLY_PREVALIDATED_CST = {} as PrevalidatedInput["cst"];

export function formatSnippet(source: string): string {
  return prettyPrintToSource({ source, cst: TEST_ONLY_PREVALIDATED_CST });
}
