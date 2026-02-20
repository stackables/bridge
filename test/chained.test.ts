import { buildHTTPExecutor } from "@graphql-tools/executor-http";
import { parse } from "graphql";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBridge } from "../src/bridge-format.js";
import { createGateway } from "./_gateway.js";

const typeDefs = /* GraphQL */ `
  type Query {
    livingStandard(location: String!): LivingStandard
  }
  type LivingStandard {
    lifeExpectancy: Int
  }
`;

const bridgeText = `
bridge Query.livingStandard {
  with hereapi.geocode as gc
  with companyX.getLivingStandard as cx
  with input as i
  with toInt as ti
  with output as out

gc.q <- i.location
cx.x <- gc.lat
cx.y <- gc.lon
ti.value <- cx.lifeExpectancy
out.lifeExpectancy <- ti.result

}`;

const chainedTools: Record<string, any> = {
  "hereapi.geocode": async (params: any) => {
    return { lat: 52.53, lon: 13.38 };
  },
  "companyX.getLivingStandard": async (params: any) => {
    if (params.x === 52.53 && params.y === 13.38) {
      return { lifeExpectancy: "81.5" };
    }
    throw new Error(`Unexpected params: ${JSON.stringify(params)}`);
  },
  toInt: (params: { value: string }) => ({
    result: Math.round(parseFloat(params.value)),
  }),
};

function makeExecutor() {
  const instructions = parseBridge(bridgeText);
  const gateway = createGateway(typeDefs, instructions, {
    tools: chainedTools,
  });
  return buildHTTPExecutor({ fetch: gateway.fetch as any });
}

describe("chained providers", () => {
  test("input -> geocode -> livingStandard -> tool -> output", async () => {
    const executor = makeExecutor();
    const result: any = await executor({
      document: parse(
        `{ livingStandard(location: "Berlin") { lifeExpectancy } }`,
      ),
    });
    assert.equal(result.data.livingStandard.lifeExpectancy, 82);
  });

  test("geocode receives input params", async () => {
    let geoParams: Record<string, any> = {};
    const spy = async (params: any) => {
      geoParams = params;
      return chainedTools["hereapi.geocode"](params);
    };

    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, {
      tools: { ...chainedTools, "hereapi.geocode": spy },
    });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    await executor({
      document: parse(
        `{ livingStandard(location: "Berlin") { lifeExpectancy } }`,
      ),
    });

    assert.equal(geoParams.q, "Berlin");
  });

  test("companyX receives chained geocode output", async () => {
    let cxParams: Record<string, any> = {};
    const spy = async (params: any) => {
      cxParams = params;
      return chainedTools["companyX.getLivingStandard"](params);
    };

    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, {
      tools: { ...chainedTools, "companyX.getLivingStandard": spy },
    });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    await executor({
      document: parse(
        `{ livingStandard(location: "Berlin") { lifeExpectancy } }`,
      ),
    });

    assert.equal(cxParams.x, 52.53);
    assert.equal(cxParams.y, 13.38);
  });
});
