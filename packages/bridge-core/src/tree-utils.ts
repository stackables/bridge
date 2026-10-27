/**
 * Pure utility functions used by the execution engine.
 */

// ── Nested property helpers ─────────────────────────────────────────────────

export const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// ── Timing ──────────────────────────────────────────────────────────────────

export function roundMs(ms: number): number {
  return Math.round(ms * 100) / 100;
}
