import { createSchema, createYoga } from "graphql-yoga";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { bridgeTransform, parseBridge } from "../../src/index.js";

const typeDefs = readFileSync(
  new URL("./Email.graphql", import.meta.url),
  "utf-8",
);
const instructions = parseBridge(
  readFileSync(new URL("./sendgrid.bridge", import.meta.url), "utf-8"),
);

const schema = bridgeTransform(createSchema({ typeDefs }), instructions);

const yoga = createYoga({
  schema,
  context: () => ({
    config: {
      sendgrid: { bearerToken: `Bearer ${process.env.SENDGRID_API_KEY}` },
    },
  }),
});

createServer(yoga).listen(4000, () => {
  console.log("Email gateway running at http://localhost:4000/graphql");
});
