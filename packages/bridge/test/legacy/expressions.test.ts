import assert from "node:assert/strict";
import { test } from "node:test";
import { forEachEngine } from "../utils/dual-run.ts";

// ── Short-circuit tests ───────────────────────────────────────────────────────

forEachEngine("and/or short-circuit behavior", (run, { engine }) => {
  test(
    "and short-circuits: right side not evaluated when left is false",
    { skip: engine === "compiled" },
    async () => {
      let rightEvaluated = false;
      const { data } = await run(
        `version 1.5
bridge Query.test {
  with input as i
  with checker as c
  with output as o

  c.in <- i.value
  o.result <- i.flag and c.ok
}`,
        "Query.test",
        { flag: false, value: "test" },
        {
          checker: async () => {
            rightEvaluated = true;
            return { ok: true };
          },
        },
      );
      assert.equal(data.result, false);
      assert.equal(
        rightEvaluated,
        false,
        "right side should NOT be evaluated when left is false",
      );
    },
  );

  test(
    "and evaluates right side when left is true",
    { skip: engine === "compiled" },
    async () => {
      let rightEvaluated = false;
      const { data } = await run(
        `version 1.5
bridge Query.test {
  with input as i
  with checker as c
  with output as o

  c.in <- i.value
  o.result <- i.flag and c.ok
}`,
        "Query.test",
        { flag: true, value: "test" },
        {
          checker: async () => {
            rightEvaluated = true;
            return { ok: true };
          },
        },
      );
      assert.equal(data.result, true);
      assert.equal(
        rightEvaluated,
        true,
        "right side should be evaluated when left is true",
      );
    },
  );

  test(
    "or short-circuits: right side not evaluated when left is true",
    { skip: engine === "compiled" },
    async () => {
      let rightEvaluated = false;
      const { data } = await run(
        `version 1.5
bridge Query.test {
  with input as i
  with checker as c
  with output as o

  c.in <- i.value
  o.result <- i.flag or c.ok
}`,
        "Query.test",
        { flag: true, value: "test" },
        {
          checker: async () => {
            rightEvaluated = true;
            return { ok: true };
          },
        },
      );
      assert.equal(data.result, true);
      assert.equal(
        rightEvaluated,
        false,
        "right side should NOT be evaluated when left is true",
      );
    },
  );

  test(
    "or evaluates right side when left is false",
    { skip: engine === "compiled" },
    async () => {
      let rightEvaluated = false;
      const { data } = await run(
        `version 1.5
bridge Query.test {
  with input as i
  with checker as c
  with output as o

  c.in <- i.value
  o.result <- i.flag or c.ok
}`,
        "Query.test",
        { flag: false, value: "test" },
        {
          checker: async () => {
            rightEvaluated = true;
            return { ok: false };
          },
        },
      );
      assert.equal(data.result, false);
      assert.equal(
        rightEvaluated,
        true,
        "right side should be evaluated when left is false",
      );
    },
  );
});
