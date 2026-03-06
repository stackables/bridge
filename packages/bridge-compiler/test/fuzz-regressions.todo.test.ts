import { describe, test } from "node:test";

describe("fuzz-discovered AOT/runtime divergence backlog", () => {
  // AOT compiler uses `?.` safe-navigation everywhere in generated code; runtime
  // throws TypeError for unsafe path traversal when `rootSafe` is not set.
  // These seeds reproduce the divergence via fuzz-runtime-parity.test.ts.
  test.todo(
    "deep-path parity: AOT silently returns undefined where runtime throws TypeError for unsafe traversal (seed=1798655022)",
  );
  test.todo(
    "deep-path fallback parity: AOT silently returns undefined where runtime throws TypeError for unsafe traversal (seed=-481664925)",
  );
  // AOT and runtime diverge on null-vs-undefined semantics when fallback constant
  // wires (catchFallback / falsy fallbacks) resolve to "null". The AOT emits null
  // while the runtime applies overdefinition coalescing and produces undefined.
  // Repro: fuzz-runtime-parity deepFallbackBridgeArb + chaosInputArb, any random seed.
  test.todo(
    "fallback parity: AOT returns null where runtime returns undefined when fallback constant resolves to null (seed=random)",
  );
  // Array mapping: when an array contains null elements, the runtime throws TypeError
  // when accessing a field on the null element (element refs lack rootSafe), while
  // the AOT generates element?.field and silently returns undefined.
  // Repro: fuzz-runtime-parity arrayBridgeSpec + [null] element in source array.
  test.todo(
    "array mapping: runtime throws TypeError for null array elements; AOT returns undefined (null element divergence)",
  );
  // Array mapping: when a bridge has `.elemField <- el.elemField` where elemField
  // equals the source array path (e.g. `o.items <- i.data[] as el { .data <- el.data }`),
  // the runtime conflates the shadow-tree element wire with the outer input-array source
  // wire because they have the same trunk key (element flag not factored into trunkKey).
  // AOT correctly handles this via separate code paths for element refs.
  // Repro: arrayBridgeSpec where elemFields contains srcField.
  test.todo(
    "array mapping: element field with same name as source field causes trunk key collision in runtime",
  );
  // Array mapping: when source value is a non-array non-null (e.g. a string), AOT
  // throws TypeError (.map is not a function), while the runtime iterates iterable
  // types (strings char-by-char) via createShadowArray. Numbers return [].
  // Repro: arrayBridgeSpec + source = "hello" or 42.
  test.todo(
    "array mapping: non-array source diverges — AOT throws TypeError, runtime uses iterable semantics",
  );
});
