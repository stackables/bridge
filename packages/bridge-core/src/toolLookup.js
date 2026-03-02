/**
 * Tool function lookup, ToolDef resolution, and tool-dependency execution.
 *
 * Extracted from ExecutionTree.ts — Phase 3 of the refactor.
 * See docs/execution-tree-refactor.md
 *
 * All functions take a `ToolLookupContext` instead of accessing `this`,
 * keeping the dependency surface explicit and testable.
 */
import { parsePath } from "./utils.js";
import { SELF_MODULE } from "./types.js";
import { trunkKey, setNested, coerceConstant, UNSAFE_KEYS, } from "./tree-utils.js";
// ── Tool function lookup ────────────────────────────────────────────────────
/**
 * Deep-lookup a tool function by dotted name (e.g. "std.str.toUpperCase").
 * Falls back to a flat key lookup for backward compat (e.g. "hereapi.geocode"
 * as literal key).
 */
export function lookupToolFn(ctx, name) {
    const toolFns = ctx.toolFns;
    if (name.includes(".")) {
        // Try namespace traversal first
        const parts = name.split(".");
        let current = toolFns;
        for (const part of parts) {
            if (UNSAFE_KEYS.has(part))
                return undefined;
            if (current == null || typeof current !== "object") {
                current = undefined;
                break;
            }
            current = current[part];
        }
        if (typeof current === "function")
            return current;
        // Fall back to flat key (e.g. "hereapi.geocode" as a literal property name)
        const flat = toolFns?.[name];
        if (typeof flat === "function")
            return flat;
        // Try versioned namespace keys (e.g. "std.str@999.1" → { toLowerCase })
        // For "std.str.toLowerCase@999.1", check:
        //   toolFns["std.str@999.1"]?.toLowerCase
        //   toolFns["std@999.1"]?.str?.toLowerCase
        const atIdx = name.lastIndexOf("@");
        if (atIdx > 0) {
            const baseName = name.substring(0, atIdx);
            const version = name.substring(atIdx + 1);
            const nameParts = baseName.split(".");
            for (let i = nameParts.length - 1; i >= 1; i--) {
                const nsKey = nameParts.slice(0, i).join(".") + "@" + version;
                const remainder = nameParts.slice(i);
                let ns = toolFns?.[nsKey];
                if (ns != null && typeof ns === "object") {
                    for (const part of remainder) {
                        if (ns == null || typeof ns !== "object") {
                            ns = undefined;
                            break;
                        }
                        ns = ns[part];
                    }
                    if (typeof ns === "function")
                        return ns;
                }
            }
        }
        return undefined;
    }
    // Try root level first
    const fn = toolFns?.[name];
    if (typeof fn === "function")
        return fn;
    // Fall back to std namespace (builtins are callable without std. prefix)
    const stdFn = toolFns?.std?.[name];
    if (typeof stdFn === "function")
        return stdFn;
    // Fall back to internal namespace (engine-internal tools: math ops, concat, etc.)
    const internalFn = toolFns?.internal?.[name];
    return typeof internalFn === "function" ? internalFn : undefined;
}
// ── ToolDef resolution ──────────────────────────────────────────────────────
/**
 * Resolve a ToolDef by name, merging the extends chain (cached).
 */
export function resolveToolDefByName(ctx, name) {
    if (ctx.toolDefCache.has(name))
        return ctx.toolDefCache.get(name) ?? undefined;
    const toolDefs = ctx.instructions.filter((i) => i.kind === "tool");
    const base = toolDefs.find((t) => t.name === name);
    if (!base) {
        ctx.toolDefCache.set(name, null);
        return undefined;
    }
    // Build extends chain: root → ... → leaf
    const chain = [base];
    let current = base;
    while (current.extends) {
        const parent = toolDefs.find((t) => t.name === current.extends);
        if (!parent)
            throw new Error(`Tool "${current.name}" extends unknown tool "${current.extends}"`);
        chain.unshift(parent);
        current = parent;
    }
    // Merge: root provides base, each child overrides
    const merged = {
        kind: "tool",
        name,
        fn: chain[0].fn, // fn from root ancestor
        deps: [],
        wires: [],
    };
    for (const def of chain) {
        // Merge deps (dedupe by handle)
        for (const dep of def.deps) {
            if (!merged.deps.some((d) => d.handle === dep.handle)) {
                merged.deps.push(dep);
            }
        }
        // Merge wires (child overrides parent by target; onError replaces onError)
        for (const wire of def.wires) {
            if (wire.kind === "onError") {
                const idx = merged.wires.findIndex((w) => w.kind === "onError");
                if (idx >= 0)
                    merged.wires[idx] = wire;
                else
                    merged.wires.push(wire);
            }
            else {
                const idx = merged.wires.findIndex((w) => "target" in w && w.target === wire.target);
                if (idx >= 0)
                    merged.wires[idx] = wire;
                else
                    merged.wires.push(wire);
            }
        }
    }
    ctx.toolDefCache.set(name, merged);
    return merged;
}
// ── Tool wire resolution ────────────────────────────────────────────────────
/**
 * Resolve a tool definition's wires into a nested input object.
 */
export async function resolveToolWires(ctx, toolDef, input) {
    // Constants applied synchronously
    for (const wire of toolDef.wires) {
        if (wire.kind === "constant") {
            setNested(input, parsePath(wire.target), coerceConstant(wire.value));
        }
    }
    // Pull wires resolved in parallel (independent deps shouldn't wait on each other)
    const pullWires = toolDef.wires.filter((w) => w.kind === "pull");
    if (pullWires.length > 0) {
        const resolved = await Promise.all(pullWires.map(async (wire) => ({
            target: wire.target,
            value: await resolveToolSource(ctx, wire.source, toolDef),
        })));
        for (const { target, value } of resolved) {
            setNested(input, parsePath(target), value);
        }
    }
}
// ── Tool source resolution ──────────────────────────────────────────────────
/**
 * Resolve a source reference from a tool wire against its dependencies.
 */
export async function resolveToolSource(ctx, source, toolDef) {
    const dotIdx = source.indexOf(".");
    const handle = dotIdx === -1 ? source : source.substring(0, dotIdx);
    const restPath = dotIdx === -1 ? [] : source.substring(dotIdx + 1).split(".");
    const dep = toolDef.deps.find((d) => d.handle === handle);
    if (!dep)
        throw new Error(`Unknown source "${handle}" in tool "${toolDef.name}"`);
    let value;
    if (dep.kind === "context") {
        // Walk the full parent chain for context
        let cursor = ctx;
        while (cursor && value === undefined) {
            value = cursor.context;
            cursor = cursor.parent;
        }
    }
    else if (dep.kind === "const") {
        // Walk the full parent chain for const state
        const constKey = trunkKey({
            module: SELF_MODULE,
            type: "Const",
            field: "const",
        });
        let cursor = ctx;
        while (cursor && value === undefined) {
            value = cursor.state[constKey];
            cursor = cursor.parent;
        }
    }
    else if (dep.kind === "tool") {
        value = await resolveToolDep(ctx, dep.tool);
    }
    for (const segment of restPath) {
        value = value?.[segment];
    }
    return value;
}
// ── Tool dependency execution ───────────────────────────────────────────────
/**
 * Call a tool dependency (cached per request).
 * Delegates to the root of the parent chain so shadow trees share the cache.
 */
export function resolveToolDep(ctx, toolName) {
    // Check parent first (shadow trees delegate)
    if (ctx.parent)
        return resolveToolDep(ctx.parent, toolName);
    if (ctx.toolDepCache.has(toolName))
        return ctx.toolDepCache.get(toolName);
    const promise = (async () => {
        const toolDef = resolveToolDefByName(ctx, toolName);
        if (!toolDef)
            throw new Error(`Tool dependency "${toolName}" not found`);
        const input = {};
        await resolveToolWires(ctx, toolDef, input);
        const fn = lookupToolFn(ctx, toolDef.fn);
        if (!fn)
            throw new Error(`Tool function "${toolDef.fn}" not registered`);
        // on error: wrap the tool call with fallback from onError wire
        const onErrorWire = toolDef.wires.find((w) => w.kind === "onError");
        try {
            return await ctx.callTool(toolName, toolDef.fn, fn, input);
        }
        catch (err) {
            if (!onErrorWire)
                throw err;
            if ("value" in onErrorWire)
                return JSON.parse(onErrorWire.value);
            return resolveToolSource(ctx, onErrorWire.source, toolDef);
        }
    })();
    ctx.toolDepCache.set(toolName, promise);
    return promise;
}
