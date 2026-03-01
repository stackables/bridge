/**
 * Core types, error classes, sentinels, and lightweight helpers used
 * across the execution-tree modules.
 *
 * Extracted from ExecutionTree.ts — Phase 1 of the refactor.
 * See docs/execution-tree-refactor.md
 */

import type { ControlFlowInstruction } from "./types.ts";

// ── Error classes ───────────────────────────────────────────────────────────

/** Fatal panic error — bypasses all error boundaries (`?.` and `catch`). */
export class BridgePanicError extends Error {
  constructor(message: string) {
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

// ── Sentinels ───────────────────────────────────────────────────────────────

/** Sentinel for `continue` — skip the current array element */
export const CONTINUE_SYM = Symbol.for("BRIDGE_CONTINUE");
/** Sentinel for `break` — halt array iteration */
export const BREAK_SYM = Symbol.for("BRIDGE_BREAK");

// ── Constants ───────────────────────────────────────────────────────────────

/** Maximum shadow-tree nesting depth before a BridgePanicError is thrown. */
export const MAX_EXECUTION_DEPTH = 30;

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * A value that may already be resolved (synchronous) or still pending (asynchronous).
 * Using this instead of always returning `Promise<T>` lets callers skip
 * microtask scheduling when the value is immediately available.
 * See docs/performance.md (#10).
 */
export type MaybePromise<T> = T | Promise<T>;

export type Trunk = {
  module: string;
  type: string;
  field: string;
  instance?: number;
};

/**
 * Structured logger interface for Bridge engine events.
 * Accepts any compatible logger: pino, winston, bunyan, `console`, etc.
 * All methods default to silent no-ops when no logger is provided.
 */
export interface Logger {
  debug?: (...args: any[]) => void;
  info?: (...args: any[]) => void;
  warn?: (...args: any[]) => void;
  error?: (...args: any[]) => void;
}

/** Matches graphql's internal Path type (not part of the public exports map) */
export interface Path {
  readonly prev: Path | undefined;
  readonly key: string | number;
  readonly typename: string | undefined;
}

// ── Helper functions ────────────────────────────────────────────────────────

/** Returns `true` when `value` is a thenable (Promise or Promise-like). */
export function isPromise(value: unknown): value is Promise<unknown> {
  return typeof (value as any)?.then === "function";
}

/** Check whether an error is a fatal halt (abort or panic) that must bypass all error boundaries. */
export function isFatalError(err: any): boolean {
  return (
    err instanceof BridgePanicError ||
    err instanceof BridgeAbortError ||
    err?.name === "BridgeAbortError" ||
    err?.name === "BridgePanicError"
  );
}

/** Execute a control flow instruction, returning a sentinel or throwing. */
export function applyControlFlow(ctrl: ControlFlowInstruction): symbol {
  if (ctrl.kind === "throw") throw new Error(ctrl.message);
  if (ctrl.kind === "panic") throw new BridgePanicError(ctrl.message);
  if (ctrl.kind === "continue") return CONTINUE_SYM;
  /* ctrl.kind === "break" */
  return BREAK_SYM;
}
