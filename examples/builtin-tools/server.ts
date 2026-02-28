import { createSchema, createYoga } from "graphql-yoga";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { bridgeTransform, parseBridge } from "@stackables/bridge";

const typeDefs = readFileSync(
  new URL("./BuiltinTools.graphql", import.meta.url),
  "utf-8",
);
const document = parseBridge(
  readFileSync(new URL("./builtin-tools.bridge", import.meta.url), "utf-8"),
);

// Custom tools merge alongside the std namespace automatically.
// Versioned tool keys (e.g. "std.str.toLowerCase@999.1") satisfy
// @version constraints declared in the bridge file.
const schema = bridgeTransform(createSchema({ typeDefs }), document, {
  tools: {
    getEmployees: async () => ({
      employees: [
        { id: 1, name: "Alice", department: "Engineering" },
        { id: 2, name: "Bob", department: "Marketing" },
        { id: 3, name: "Charlie", department: "Engineering" },
      ],
    }),
    // Provide the versioned tool to satisfy std.str.toLowerCase@999.1
    "std.str.toLowerCase@999.1": (opts: { in: string }) =>
      opts.in?.toLowerCase(),
  },
});

export const yoga = createYoga({ schema, graphqlEndpoint: "*" });

if (process.argv[1] === import.meta.filename) {
  createServer(yoga).listen(4000, () => {
    console.log(
      "Built-in tools example running at http://localhost:4000/graphql",
    );
    console.log(
      'Try: { format(text: "Hello World") { original upper lower } }',
    );
    console.log('Try: { findEmployee(department: "Engineering") { id name } }');
  });
}
