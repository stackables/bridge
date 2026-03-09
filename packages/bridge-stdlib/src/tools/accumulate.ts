import type { StreamToolCallFn, ToolMetadata } from "@stackables/bridge-types";

/**
 * Deep-merge `item` into `accumulator` in-place.
 *
 * Merge rules:
 * - `undefined` / `null` values in `item` are skipped (keep accumulator value)
 * - Both arrays → merge element-by-element (recurse for objects)
 * - Both objects → recurse
 * - Both strings → concatenate
 * - Otherwise → overwrite with the new value
 */
function deepMergeStream(
  accumulator: Record<string, unknown>,
  item: Record<string, unknown>,
): void {
  for (const key of Object.keys(item)) {
    const newVal = item[key];
    if (newVal === undefined || newVal === null) continue;
    const oldVal = accumulator[key];
    if (Array.isArray(oldVal) && Array.isArray(newVal)) {
      for (let i = 0; i < newVal.length; i++) {
        const oldElem = oldVal[i];
        const newElem = newVal[i];
        if (newElem === undefined || newElem === null) continue;
        if (
          oldElem != null &&
          typeof oldElem === "object" &&
          !Array.isArray(oldElem) &&
          typeof newElem === "object" &&
          !Array.isArray(newElem)
        ) {
          deepMergeStream(
            oldElem as Record<string, unknown>,
            newElem as Record<string, unknown>,
          );
        } else {
          oldVal[i] = newElem;
        }
      }
    } else if (
      oldVal != null &&
      typeof oldVal === "object" &&
      !Array.isArray(oldVal) &&
      typeof newVal === "object" &&
      !Array.isArray(newVal)
    ) {
      deepMergeStream(
        oldVal as Record<string, unknown>,
        newVal as Record<string, unknown>,
      );
    } else if (typeof oldVal === "string" && typeof newVal === "string") {
      accumulator[key] = oldVal + newVal;
    } else {
      accumulator[key] = newVal;
    }
  }
}

/**
 * `std.accumulate` — a stream-to-stream tool that wraps a source stream
 * with deep-merge accumulation and optional throttling.
 *
 * Receives a source async generator via `input._source` (set by the engine
 * when a StreamHandle is wired to this tool's trunk at the root path).
 * Iterates the source, deep-merges each item into an accumulator, and
 * yields the full accumulated state.
 *
 * Options (set via tool wires):
 * - `.interval` (number, ms) — minimum time between emissions.  When set,
 *    intermediate items are merged silently and only emitted once the
 *    interval has elapsed.  The final accumulated state is always emitted.
 *
 * Bridge usage:
 * ```bridge
 * tool buf from std.accumulate {
 *   .interval = 100
 * }
 *
 * bridge Mutation.deepseekStream {
 *   with deepseekApi as api
 *   with buf
 *   with output as o
 *
 *   buf <- api[] as result {
 *     .role <- result.choices[0].delta.role
 *     .content <- result.choices[0].delta.content
 *   }
 *   o[0] <- buf[] as a {
 *     ...a
 *   }
 * }
 * ```
 */
export function createAccumulate(): StreamToolCallFn & {
  bridge: ToolMetadata;
} {
  async function* accumulate(
    input: Record<string, any>,
  ): AsyncGenerator<unknown, void, undefined> {
    const source: AsyncIterable<unknown> | undefined = input._source;
    if (!source) return;

    const interval = typeof input.interval === "number" ? input.interval : 0;
    const accumulator: Record<string, unknown> = {};
    let lastYieldTime = 0;
    let pending = false;

    for await (const item of source) {
      if (item != null && typeof item === "object" && !Array.isArray(item)) {
        deepMergeStream(accumulator, item as Record<string, unknown>);
      }
      const now = Date.now();
      if (interval <= 0 || now - lastYieldTime >= interval) {
        yield structuredClone(accumulator);
        lastYieldTime = now;
        pending = false;
      } else {
        pending = true;
      }
    }

    // Always emit the final accumulated state
    if (pending) {
      yield structuredClone(accumulator);
    }
  }

  accumulate.bridge = { stream: true } as const;
  return accumulate;
}
