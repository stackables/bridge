import { describe } from "node:test";

describe("fuzz-discovered AOT/runtime divergence backlog", () => {
  //   test.todo(
  //     "parser round-trip: serializeBridge output can be unparsable for some valid parsed documents (seed=1864118703)",
  //   );
  // AOT compiler uses `?.` safe-navigation everywhere in generated code; runtime
  // throws TypeError for unsafe path traversal when `rootSafe` is not set.
  // These seeds reproduce the divergence via fuzz-runtime-parity.test.ts.
  // test.todo(
  //   "deep-path parity: AOT silently returns undefined where runtime throws TypeError for unsafe traversal (seed=1798655022)",
  // );
  // test.todo(
  //   "deep-path fallback parity: AOT silently returns undefined where runtime throws TypeError for unsafe traversal (seed=-481664925)",
  // );
  // AOT and runtime diverge on null-vs-undefined semantics when fallback constant
  // wires (catchFallback / falsy fallbacks) resolve to "null". The AOT emits null
  // while the runtime applies overdefinition coalescing and produces undefined.
  // Repro: fuzz-runtime-parity deepFallbackBridgeArb + chaosInputArb, any random seed.
  // test.todo(
  //   "fallback parity: AOT returns null where runtime returns undefined when fallback constant resolves to null (seed=random)",
  // );
});
