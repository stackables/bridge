/**
 * Core types, error classes, sentinels, and lightweight helpers used
 * across the execution-tree modules.
 *
 * Extracted from ExecutionTree.ts — Phase 1 of the refactor.
 * See docs/execution-tree-refactor.md
 */
// ── Error classes ───────────────────────────────────────────────────────────
/** Fatal panic error — bypasses all error boundaries (`?.` and `catch`). */
export class BridgePanicError extends Error {
    constructor(message) {
        super(message);
        this.name = "BridgePanicError";
    }
}
/** Abort error — raised when an external AbortSignal cancels execution. */
export class BridgeAbortError extends Error {
    constructor(message = "Execution aborted by external signal") {
        super(message);
        this.name = "BridgeAbortError";
    }
}
/** Timeout error — raised when a tool call exceeds the configured timeout. */
export class BridgeTimeoutError extends Error {
    constructor(toolName, timeoutMs) {
        super(`Tool "${toolName}" timed out after ${timeoutMs}ms`);
        this.name = "BridgeTimeoutError";
    }
}
// ── Sentinels ───────────────────────────────────────────────────────────────
/** Sentinel for `continue` — skip the current array element */
export const CONTINUE_SYM = Symbol.for("BRIDGE_CONTINUE");
/** Sentinel for `break` — halt array iteration */
export const BREAK_SYM = Symbol.for("BRIDGE_BREAK");
// ── Constants ───────────────────────────────────────────────────────────────
/** Maximum shadow-tree nesting depth before a BridgePanicError is thrown. */
export const MAX_EXECUTION_DEPTH = 30;
/** Returns `true` when `value` is a thenable (Promise or Promise-like). */
export function isPromise(value) {
    return typeof value?.then === "function";
}
/** Check whether an error is a fatal halt (abort or panic) that must bypass all error boundaries. */
export function isFatalError(err) {
    return (err instanceof BridgePanicError ||
        err instanceof BridgeAbortError ||
        err?.name === "BridgeAbortError" ||
        err?.name === "BridgePanicError");
}
/** Execute a control flow instruction, returning a sentinel or throwing. */
export function applyControlFlow(ctrl) {
    if (ctrl.kind === "throw")
        throw new Error(ctrl.message);
    if (ctrl.kind === "panic")
        throw new BridgePanicError(ctrl.message);
    if (ctrl.kind === "continue")
        return CONTINUE_SYM;
    /* ctrl.kind === "break" */
    return BREAK_SYM;
}
