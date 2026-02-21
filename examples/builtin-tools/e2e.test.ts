import assert from "node:assert/strict";
import { test } from "node:test";
import { yoga } from "./server.js";

async function gql(query: string, variables?: Record<string, unknown>) {
  const res = await yoga.fetch("http://test/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json()) as { data?: any; errors?: any[] };
  if (body.errors?.length) {
    throw new Error(`GraphQL errors: ${JSON.stringify(body.errors, null, 2)}`);
  }
  return body.data;
}

test("format returns upper and lower case", async () => {
  const data = await gql(`{ format(text: "Hello World") { original upper lower } }`);
  assert.equal(data.format.original, "Hello World");
  assert.equal(data.format.upper, "HELLO WORLD");
  assert.equal(data.format.lower, "hello world");
});

test("findEmployee finds by department", async () => {
  const data = await gql(`{ findEmployee(department: "Marketing") { id name department } }`);
  assert.equal(data.findEmployee.name, "Bob");
  assert.equal(data.findEmployee.department, "Marketing");
});
