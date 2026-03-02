/**
 * Shared utilities for the Bridge runtime.
 */
/**
 * Split a dotted path string into path segments, expanding array indices.
 * e.g. "items[0].name" → ["items", "0", "name"]
 */
export declare function parsePath(text: string): string[];
/** Race a promise against a timeout.  Rejects with BridgeTimeoutError on expiry. */
export declare function raceTimeout<T>(promise: Promise<T>, ms: number, toolName: string): Promise<T>;
//# sourceMappingURL=utils.d.ts.map