/**
 * Shadow-tree materializer — converts shadow trees into plain JS objects.
 *
 * Extracted from ExecutionTree.ts — Phase 4 of the refactor.
 * See docs/execution-tree-refactor.md
 *
 * The functions operate on a narrow `MaterializerHost` interface (for bridge
 * metadata) and concrete `ExecutionTree` instances (for shadow resolution).
 */
import { SELF_MODULE } from "./types.js";
import { setNested } from "./tree-utils.js";
import { isPromise, CONTINUE_SYM, BREAK_SYM } from "./tree-types.js";
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
export function planShadowOutput(host, pathPrefix) {
    const wires = host.bridge.wires;
    const { type, field } = host.trunk;
    const directFields = new Set();
    const deepPaths = new Map();
    // #8: Pre-group wires by exact path — eliminates per-element re-filtering.
    // Key: wire.to.path joined by \0 (null char is safe — field names are identifiers).
    const wireGroupsByPath = new Map();
    for (const wire of wires) {
        const p = wire.to.path;
        if (wire.to.module !== SELF_MODULE ||
            wire.to.type !== type ||
            wire.to.field !== field)
            continue;
        if (p.length <= pathPrefix.length)
            continue;
        if (!pathPrefix.every((seg, i) => p[i] === seg))
            continue;
        const name = p[pathPrefix.length];
        if (p.length === pathPrefix.length + 1) {
            directFields.add(name);
            const pathKey = p.join("\0");
            let group = wireGroupsByPath.get(pathKey);
            if (!group) {
                group = [];
                wireGroupsByPath.set(pathKey, group);
            }
            group.push(wire);
        }
        else {
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
export async function materializeShadows(host, items, pathPrefix) {
    const { directFields, deepPaths, wireGroupsByPath } = planShadowOutput(host, pathPrefix);
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
        const preGroups = new Array(nFields);
        for (let j = 0; j < nFields; j++) {
            const pathKey = [...pathPrefix, directFieldArray[j]].join("\0");
            preGroups[j] = wireGroupsByPath.get(pathKey);
        }
        const rawValues = new Array(nItems * nFields);
        let hasAsync = false;
        for (let i = 0; i < nItems; i++) {
            const shadow = items[i];
            for (let j = 0; j < nFields; j++) {
                const v = shadow.resolvePreGrouped(preGroups[j]);
                rawValues[i * nFields + j] = v;
                if (!hasAsync && isPromise(v))
                    hasAsync = true;
            }
        }
        const flatValues = hasAsync
            ? await Promise.all(rawValues)
            : rawValues;
        const finalResults = [];
        for (let i = 0; i < items.length; i++) {
            const obj = {};
            let doBreak = false;
            let doSkip = false;
            for (let j = 0; j < nFields; j++) {
                const v = flatValues[i * nFields + j];
                if (v === BREAK_SYM) {
                    doBreak = true;
                    break;
                }
                if (v === CONTINUE_SYM) {
                    doSkip = true;
                    break;
                }
                obj[directFieldArray[j]] = v;
            }
            if (doBreak)
                break;
            if (doSkip)
                continue;
            finalResults.push(obj);
        }
        return finalResults;
    }
    // Slow path: deep paths (nested arrays) present.
    // Uses pre-grouped wires for direct fields (#8), original logic for the rest.
    const rawResults = await Promise.all(items.map(async (shadow) => {
        const obj = {};
        const tasks = [];
        for (const name of directFields) {
            const fullPath = [...pathPrefix, name];
            const hasDeeper = deepPaths.has(name);
            tasks.push((async () => {
                if (hasDeeper) {
                    const children = await shadow.pullOutputField(fullPath, true);
                    obj[name] = Array.isArray(children)
                        ? await materializeShadows(host, children, fullPath)
                        : children;
                }
                else {
                    // #8: wireGroupsByPath is built in the same branch that populates
                    // directFields, so the group is always present — no fallback needed.
                    const pathKey = fullPath.join("\0");
                    obj[name] = await shadow.resolvePreGrouped(wireGroupsByPath.get(pathKey));
                }
            })());
        }
        for (const [name, paths] of deepPaths) {
            if (directFields.has(name))
                continue;
            tasks.push((async () => {
                const nested = {};
                await Promise.all(paths.map(async (fullPath) => {
                    const value = await shadow.pullOutputField(fullPath);
                    setNested(nested, fullPath.slice(pathPrefix.length + 1), value);
                }));
                obj[name] = nested;
            })());
        }
        await Promise.all(tasks);
        // Check if any field resolved to a sentinel — propagate it
        for (const v of Object.values(obj)) {
            if (v === CONTINUE_SYM)
                return CONTINUE_SYM;
            if (v === BREAK_SYM)
                return BREAK_SYM;
        }
        return obj;
    }));
    // Filter sentinels from the final result
    const finalResults = [];
    for (const item of rawResults) {
        if (item === BREAK_SYM)
            break;
        if (item === CONTINUE_SYM)
            continue;
        finalResults.push(item);
    }
    return finalResults;
}
