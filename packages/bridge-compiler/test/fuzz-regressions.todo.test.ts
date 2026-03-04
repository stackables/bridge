import { describe, test } from "node:test";

describe("fuzz-discovered AOT/runtime divergence backlog", () => {
  test.todo(
    "nullish fallback parity: AOT returned null while runtime returned undefined (seed=1245428388)",
  );

  test.todo(
    "overdefinition precedence parity: AOT resolved later constant while runtime kept earlier value (seed=562020200)",
  );

  test.todo(
    "parser round-trip: serializeBridge output can be unparsable for some valid parsed documents (seed=1864118703)",
  );
});
