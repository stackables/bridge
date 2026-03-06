/**
 * Shadow-tree materializer — converts shadow trees into plain JS objects.
 *
 * Extracted from ExecutionTree.ts — Phase 4 of the refactor.
 * See docs/execution-tree-refactor.md
 *
 * The functions operate on a narrow `MaterializerHost` interface (for bridge
 * metadata) and concrete `ExecutionTree` instances (for shadow resolution).
 */

import type { Wire } from "./types.ts";
import { SELF_MODULE } from "./types.ts";
import { setNested } from "./tree-utils.ts";
import {
  BREAK_SYM,
  CONTINUE_SYM,
  decrementLoopControl,
  isLoopControlSignal,
  isPromise,
  type LoopControlSignal,
} from "./tree-types.ts";
import type { MaybePromise, Trunk } from "./tree-types.ts";
import { matchesRequestedFields } from "./requested-fields.ts";

// ── Context interface ───────────────────────────────────────────────────────

/**
 * Narrow read-only view into the bridge metadata needed by the materializer.
 *
 * `ExecutionTree` satisfies this via its existing public fields.
 */
export interface MaterializerHost {
  readonly bridge: { readonly wires: readonly Wire[] } | undefined;
  readonly trunk: Trunk;
  /** Sparse fieldset filter — passed through from ExecutionTree. */
  readonly requestedFields?: string[] | undefined;
}

// ── Shadow tree duck type ───────────────────────────────────────────────────

/**
 * Minimal interface for shadow trees consumed by the materializer.
 *
 * `ExecutionTree` satisfies this via its existing public methods.
 */
export interface MaterializableShadow {
  pullOutputField(path: string[], array?: boolean): Promise<unknown>;
  resolvePreGrouped(wires: Wire[]): MaybePromise<unknown>;
}

// ── Plan shadow output ──────────────────────────────────────────────────────

/**
 * Scan bridge wires to classify output fields at a given path prefix.
 *
 * Returns a "plan" describing:
 *   - `directFields` — leaf fields with wires at exactly `[...prefix, name]`
 *   - `deepPaths`    — fields with wires deeper than prefix+1 (nested arrays/objects)
 *   - `wireGroupsByPath` — wires pre-grouped by their full path key (#8)
 *
 * The plan is pure data (no side-effects) and is consumed by
 * `materializeShadows` to drive the execution phase.
 */
export function planShadowOutput(host: MaterializerHost, pathPrefix: string[]) {
  const wires = host.bridge!.wires;
  const { type, field } = host.trunk;

  const directFields = new Set<string>();
  const deepPaths = new Map<string, string[][]>();
  // #8: Pre-group wires by exact path — eliminates per-element re-filtering.
  // Key: wire.to.path joined by \0 (null char is safe — field names are identifiers).
  const wireGroupsByPath = new Map<string, Wire[]>();

  for (const wire of wires) {
    const p = wire.to.path;
    if (
      wire.to.module !== SELF_MODULE ||
      wire.to.type !== type ||
      wire.to.field !== field
    )
      continue;
    if (p.length <= pathPrefix.length) continue;
    if (!pathPrefix.every((seg, i) => p[i] === seg)) continue;

    const name = p[pathPrefix.length]!;
    if (p.length === pathPrefix.length + 1) {
      directFields.add(name);
      const pathKey = p.join("\0");
      let group = wireGroupsByPath.get(pathKey);
      if (!group) {
        group = [];
        wireGroupsByPath.set(pathKey, group);
      }
      group.push(wire);
    } else {
      let arr = deepPaths.get(name);
      if (!arr) {
        arr = [];
        deepPaths.set(name, arr);
      }
      arr.push(p);
    }
  }

  return { directFields, deepPaths, wireGroupsByPath };
}

// ── Materialize shadows ─────────────────────────────────────────────────────

/**
 * Recursively convert shadow trees into plain JS objects.
 *
 * Wire categories at each level (prefix = P):
 *   Leaf  — `to.path = [...P, name]`, no deeper paths → scalar
 *   Array — direct wire AND deeper paths → pull as array, recurse
 *   Nested object — only deeper paths, no direct wire → pull each
 *             full path and assemble via setNested
 */
export async function materializeShadows(
  host: MaterializerHost,
  items: MaterializableShadow[],
  pathPrefix: string[],
): Promise<unknown[] | LoopControlSignal> {
  const { directFields, deepPaths, wireGroupsByPath } = planShadowOutput(
    host,
    pathPrefix,
  );

  // Apply sparse fieldset filter: remove fields not matched by requestedFields.
  const { requestedFields } = host;
  if (requestedFields && requestedFields.length > 0) {
    const prefixStr = pathPrefix.join(".");
    for (const name of [...directFields]) {
      const fullPath = prefixStr ? `${prefixStr}.${name}` : name;
      if (!matchesRequestedFields(fullPath, requestedFields)) {
        directFields.delete(name);
        const pathKey = [...pathPrefix, name].join("\0");
        wireGroupsByPath.delete(pathKey);
      }
    }
    for (const [name] of [...deepPaths]) {
      const fullPath = prefixStr ? `${prefixStr}.${name}` : name;
      if (!matchesRequestedFields(fullPath, requestedFields)) {
        deepPaths.delete(name);
      }
    }
  }

  // #9/#10: Fast path — no nested arrays, only direct fields.
  // Collect all (shadow × field) resolutions.  When every value is already in
  // state (the hot case for element passthrough), resolvePreGrouped returns
  // synchronously and we skip Promise.all entirely.
  // See docs/performance.md (#9, #10).
  if (deepPaths.size === 0) {
    const directFieldArray = [...directFields];
    const nFields = directFieldArray.length;
    const nItems = items.length;
    // Pre-compute pathKeys and wire groups — only depend on j, not i.
    // See docs/performance.md (#11).
    const preGroups: Wire[][] = new Array(nFields);
    for (let j = 0; j < nFields; j++) {
      const pathKey = [...pathPrefix, directFieldArray[j]!].join("\0");
      preGroups[j] = wireGroupsByPath.get(pathKey)!;
    }
    const rawValues: MaybePromise<unknown>[] = new Array(nItems * nFields);
    let hasAsync = false;
    for (let i = 0; i < nItems; i++) {
      const shadow = items[i]!;
      for (let j = 0; j < nFields; j++) {
        const v = shadow.resolvePreGrouped(preGroups[j]!);
        rawValues[i * nFields + j] = v;
        if (!hasAsync && isPromise(v)) hasAsync = true;
      }
    }
    const flatValues: unknown[] = hasAsync
      ? await Promise.all(rawValues)
      : (rawValues as unknown[]);

    const finalResults: unknown[] = [];
    let propagate: LoopControlSignal | undefined;
    for (let i = 0; i < items.length; i++) {
      const obj: Record<string, unknown> = {};
      let doBreak = false;
      let doSkip = false;
      for (let j = 0; j < nFields; j++) {
        const v = flatValues[i * nFields + j];
        if (isLoopControlSignal(v)) {
          if (v === BREAK_SYM) {
            doBreak = true;
            break;
          }
          if (v === CONTINUE_SYM) {
            doSkip = true;
            break;
          }
          doBreak = v.__bridgeControl === "break";
          doSkip = v.__bridgeControl === "continue";
          propagate = decrementLoopControl(v);
          break;
        }
        obj[directFieldArray[j]!] = v;
      }
      if (doBreak) break;
      if (doSkip) continue;
      finalResults.push(obj);
    }
    if (propagate) return propagate;
    return finalResults;
  }

  // Slow path: deep paths (nested arrays) present.
  // Uses pre-grouped wires for direct fields (#8), original logic for the rest.
  const rawResults = await Promise.all(
    items.map(async (shadow) => {
      const obj: Record<string, unknown> = {};
      const tasks: Promise<void>[] = [];

      for (const name of directFields) {
        const fullPath = [...pathPrefix, name];
        const hasDeeper = deepPaths.has(name);
        tasks.push(
          (async () => {
            if (hasDeeper) {
              const children = await shadow.pullOutputField(fullPath, true);
              obj[name] = Array.isArray(children)
                ? await materializeShadows(
                    host,
                    children as MaterializableShadow[],
                    fullPath,
                  )
                : children;
            } else {
              // #8: wireGroupsByPath is built in the same branch that populates
              // directFields, so the group is always present — no fallback needed.
              const pathKey = fullPath.join("\0");
              obj[name] = await shadow.resolvePreGrouped(
                wireGroupsByPath.get(pathKey)!,
              );
            }
          })(),
        );
      }

      for (const [name, paths] of deepPaths) {
        if (directFields.has(name)) continue;
        // Filter individual deep paths against requestedFields
        const activePaths =
          requestedFields && requestedFields.length > 0
            ? paths.filter((fp) =>
                matchesRequestedFields(fp.join("."), requestedFields),
              )
            : paths;
        if (activePaths.length === 0) continue;
        tasks.push(
          (async () => {
            const nested: Record<string, unknown> = {};
            await Promise.all(
              activePaths.map(async (fullPath) => {
                const value = await shadow.pullOutputField(fullPath);
                setNested(nested, fullPath.slice(pathPrefix.length + 1), value);
              }),
            );
            obj[name] = nested;
          })(),
        );
      }

      await Promise.all(tasks);
      // Check if any field resolved to a sentinel — propagate it
      for (const v of Object.values(obj)) {
        if (isLoopControlSignal(v)) return v;
      }
      return obj;
    }),
  );

  // Filter sentinels from the final result
  const finalResults: unknown[] = [];
  for (const item of rawResults) {
    if (isLoopControlSignal(item)) {
      if (item === BREAK_SYM) break;
      if (item === CONTINUE_SYM) continue;
      if (item.__bridgeControl === "break") {
        return decrementLoopControl(item);
      }
      if (item.__bridgeControl === "continue") {
        return decrementLoopControl(item);
      }
    }
    finalResults.push(item);
  }
  return finalResults;
}
