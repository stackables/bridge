import { describe, test } from "node:test";

describe("fuzz-discovered AOT/runtime divergence backlog", () => {
  // Array mapping: when a bridge has `.elemField <- el.elemField` where elemField
  // equals the source array path (e.g. `o.items <- i.data[] as el { .data <- el.data }`),
  // the runtime conflates the shadow-tree element wire with the outer input-array source
  // wire because they have the same trunk key (element flag not factored into trunkKey).
  // AOT correctly handles this via separate code paths for element refs.
  // Repro: arrayBridgeSpec where elemFields contains srcField.
  test.todo(
    "array mapping: element field with same name as source field causes trunk key collision in runtime",
  );
});
