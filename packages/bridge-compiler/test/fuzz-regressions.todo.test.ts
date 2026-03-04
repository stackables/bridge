import { describe, test } from "node:test";

describe("fuzz-discovered AOT/runtime divergence backlog", () => {
  test.todo(
    "overdefinition precedence parity: AOT resolved later constant while runtime kept earlier value (seed=562020200)",
  );

  test.todo(
    "parser round-trip: serializeBridge output can be unparsable for some valid parsed documents (seed=1864118703)",
  );
});
