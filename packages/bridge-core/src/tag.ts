/**
 * Tagged template literal for inline Bridge language definitions.
 *
 * Provides syntax highlighting in VS Code (via the Bridge extension) when
 * writing Bridge programs directly inside TypeScript/JavaScript files.
 *
 * The Bridge language is statically analysed — dynamic interpolations are not
 * part of the DSL.  Any `${}` values are stitched back in as-is; the Bridge
 * parser will reject them as a syntax error if they break the DSL structure.
 *
 * @example
 * ```ts
 * import { bridge, parseBridge } from "@stackables/bridge";
 *
 * const doc = parseBridge(bridge`
 *   version 1.5
 *   bridge Query.hello {
 *     with greeting as g
 *     output.message <- g.text
 *   }
 * `);
 * ```
 */
export function bridge(
  strings: TemplateStringsArray,
  ...values: unknown[]
): string {
  return strings.raw.reduce(
    (result, str, i) =>
      result + str + (i < values.length ? String(values[i]) : ""),
    "",
  );
}
