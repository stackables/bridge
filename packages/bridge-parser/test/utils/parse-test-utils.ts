import assert from "node:assert/strict";
import type { Statement, WireSourceEntry, WireCatch, NodeRef, SourceLocation } from "@stackables/bridge-core";
import type { ForceStatement } from "@stackables/bridge-core";

/** Flattened wire result — mirrors WireStatement but with path prefix folded into target. */
export type FlatWire = {
  target: NodeRef;
  sources: WireSourceEntry[];
  catch?: WireCatch;
  loc?: SourceLocation;
  spread?: true;
};

function omitLoc(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => omitLoc(entry));
  }

  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (
        key === "loc" ||
        key.endsWith("Loc") ||
        key === "source" ||
        key === "filename" ||
        key === "body"
      ) {
        continue;
      }
      result[key] = omitLoc(entry);
    }
    return result;
  }

  return value;
}

export function assertDeepStrictEqualIgnoringLoc(
  actual: unknown,
  expected: unknown,
  message?: string,
): void {
  assert.deepStrictEqual(omitLoc(actual), omitLoc(expected), message);
}

/**
 * Extract Wire-compatible objects from a body Statement[] tree.
 * Folds scope path prefixes into each wire's target path.
 */
export function flatWires(
  stmts: Statement[],
  pathPrefix: string[] = [],
  isElement?: boolean,
): FlatWire[] {
  const result: FlatWire[] = [];
  for (const s of stmts) {
    if (s.kind === "wire") {
      const target =
        pathPrefix.length > 0 || isElement
          ? {
              ...s.target,
              path: [...pathPrefix, ...s.target.path],
              ...(isElement ? { element: true } : {}),
            }
          : s.target;
      const w: FlatWire = { target, sources: s.sources };
      if (s.catch) w.catch = s.catch;
      if (s.loc) w.loc = s.loc;
      result.push(w);
      // Recurse into array expression bodies — children are element wires
      for (const src of s.sources) {
        if (src.expr.type === "array" && src.expr.body) {
          result.push(
            ...flatWires(
              src.expr.body,
              [...pathPrefix, ...s.target.path],
              true,
            ),
          );
        }
      }
    } else if (s.kind === "spread") {
      const target =
        pathPrefix.length > 0
          ? { module: "", type: "", field: "", path: [...pathPrefix] }
          : { module: "", type: "", field: "" as string, path: [] as string[] };
      const w: FlatWire = {
        target,
        sources: s.sources,
        spread: true,
      };
      if (s.catch) w.catch = s.catch;
      if (s.loc) w.loc = s.loc;
      result.push(w);
    } else if (s.kind === "scope") {
      result.push(
        ...flatWires(
          s.body,
          [...pathPrefix, ...s.target.path],
          isElement || s.target.element,
        ),
      );
    }
  }
  return result;
}

/**
 * Extract ForceStatement entries from a body Statement[] tree.
 * Returns them in declaration order so tests can assert by index.
 */
export function flatForces(stmts: Statement[]): ForceStatement[] {
  const result: ForceStatement[] = [];
  for (const s of stmts) {
    if (s.kind === "force") {
      result.push(s);
    } else if (s.kind === "scope") {
      result.push(...flatForces(s.body));
    }
  }
  return result;
}
