import { createSchema, createYoga } from "graphql-yoga";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { bridgeTransform, parseBridge } from "../../src/index.js";

const typeDefs = readFileSync(
  new URL("./BuiltinTools.graphql", import.meta.url),
  "utf-8",
);
const instructions = parseBridge(
  readFileSync(new URL("./builtin-tools.bridge", import.meta.url), "utf-8"),
);

// Custom tools merge alongside the std namespace automatically
const schema = bridgeTransform(createSchema({ typeDefs }), instructions, {
  tools: {
    getEmployees: async () => ({
      employees: [
        { id: 1, name: "Alice", department: "Engineering" },
        { id: 2, name: "Bob", department: "Marketing" },
        { id: 3, name: "Charlie", department: "Engineering" },
      ],
    }),
  },
});

export const yoga = createYoga({ schema, graphqlEndpoint: "*" });

if (process.argv[1] === import.meta.filename) {
  createServer(yoga).listen(4000, () => {
    console.log("Built-in tools example running at http://localhost:4000/graphql");
    console.log("Try: { format(text: \"Hello World\") { original upper lower } }");
    console.log("Try: { findEmployee(department: \"Engineering\") { id name } }");
  });
}
