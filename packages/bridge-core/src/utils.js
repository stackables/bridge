/**
 * Shared utilities for the Bridge runtime.
 */
import { BridgeTimeoutError } from "./tree-types.js";
/**
 * Split a dotted path string into path segments, expanding array indices.
 * e.g. "items[0].name" → ["items", "0", "name"]
 */
export function parsePath(text) {
    const parts = [];
    for (const segment of text.split(".")) {
        const match = segment.match(/^([^[]+)(?:\[(\d*)\])?$/);
        if (match) {
            parts.push(match[1]);
            if (match[2] !== undefined && match[2] !== "") {
                parts.push(match[2]);
            }
        }
        else {
            parts.push(segment);
        }
    }
    return parts;
}
/** Race a promise against a timeout.  Rejects with BridgeTimeoutError on expiry. */
export function raceTimeout(promise, ms, toolName) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new BridgeTimeoutError(toolName, ms)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    });
}
