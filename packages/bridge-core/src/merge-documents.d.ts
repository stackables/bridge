import type { BridgeDocument } from "./types.ts";
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
export declare function mergeBridgeDocuments(...docs: BridgeDocument[]): BridgeDocument;
//# sourceMappingURL=merge-documents.d.ts.map