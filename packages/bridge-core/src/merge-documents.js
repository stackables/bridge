/**
 * Merge multiple `BridgeDocument`s into one.
 *
 * Instructions are concatenated in order. For the version field, the
 * **highest** declared version wins — this preserves the strictest
 * compatibility requirement across all source documents. Documents
 * without a version are silently skipped during version resolution.
 *
 * Top-level names (bridges, tools, constants, defines) must be globally
 * unique across all merged documents. Duplicates cause an immediate error
 * rather than silently shadowing one another.
 *
 * @throws Error when documents declare different **major** versions
 *         (e.g. merging a `1.x` and `2.x` document is not allowed).
 * @throws Error when documents define duplicate top-level names.
 *
 * @example
 * ```ts
 * const merged = mergeBridgeDocuments(weatherDoc, quotesDoc, authDoc);
 * const schema = bridgeTransform(baseSchema, merged, { tools });
 * ```
 */
export function mergeBridgeDocuments(...docs) {
    if (docs.length === 0) {
        return { instructions: [] };
    }
    if (docs.length === 1) {
        return docs[0];
    }
    const version = resolveVersion(docs);
    const instructions = [];
    // Track global namespaces to prevent collisions across merged files
    const seenDefs = new Set();
    for (const doc of docs) {
        for (const inst of doc.instructions) {
            const key = instructionKey(inst);
            if (key) {
                if (seenDefs.has(key)) {
                    throw new Error(`Merge conflict: duplicate ${key.replace(":", " '")}' across bridge documents.`);
                }
                seenDefs.add(key);
            }
            instructions.push(inst);
        }
    }
    return { version, instructions };
}
// ── Internal ────────────────────────────────────────────────────────────────
/** Unique key for a top-level instruction, used for collision detection. */
function instructionKey(inst) {
    switch (inst.kind) {
        case "const":
            return `const:${inst.name}`;
        case "tool":
            return `tool:${inst.name}`;
        case "define":
            return `define:${inst.name}`;
        case "bridge":
            return `bridge:${inst.type}.${inst.field}`;
    }
}
/**
 * Pick the highest declared version, ensuring all documents share the same
 * major.  Returns `undefined` when no document declares a version.
 */
function resolveVersion(docs) {
    let best;
    let bestMajor = -1;
    let bestMinor = -1;
    let bestPatch = -1;
    for (const doc of docs) {
        if (!doc.version)
            continue;
        const parts = doc.version.split(".").map(Number);
        const [major = 0, minor = 0, patch = 0] = parts;
        if (best !== undefined && major !== bestMajor) {
            throw new Error(`Cannot merge bridge documents with different major versions: ` +
                `${best} vs ${doc.version}. ` +
                `Split them into separate bridgeTransform calls instead.`);
        }
        if (major > bestMajor ||
            (major === bestMajor && minor > bestMinor) ||
            (major === bestMajor && minor === bestMinor && patch > bestPatch)) {
            best = doc.version;
            bestMajor = major;
            bestMinor = minor;
            bestPatch = patch;
        }
    }
    return best;
}
