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
  const raw = strings.reduce(
    (result, str, i) =>
      result + str + (i < values.length ? String(values[i]) : ""),
    "",
  );
  // Dedent: strip the common leading indentation so that callers can indent
  // the template body to match the surrounding code without affecting output.
  const lines = raw.split("\n");
  // Remove the leading empty line produced by opening the template on a new line.
  if (lines.length > 0 && lines[0].trim() === "") lines.shift();
  // Remove only the LAST line when it is purely the closing-backtick indentation.
  // Intentional trailing blank lines (one empty line before the closing indent) are kept.
  if (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  if (lines.length === 0) return "";
  const indents = lines
    .filter((l) => l.trim() !== "")
    .map((l) => (l.match(/^(\s*)/) as RegExpMatchArray)[1].length);
  const minIndent = indents.length > 0 ? Math.min(...indents) : 0;
  if (minIndent === 0) return lines.join("\n");
  return lines.map((l) => l.slice(minIndent)).join("\n");
}
