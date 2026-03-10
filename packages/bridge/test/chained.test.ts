import assert from "node:assert/strict";
import { test } from "node:test";
import { forEachEngine } from "./utils/dual-run.ts";

const bridgeText = `version 1.5
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
  "hereapi.geocode": async (_params: any) => {
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

forEachEngine("chained providers", (run) => {
  test("input -> geocode -> livingStandard -> tool -> output", async () => {
    const { data } = await run(
      bridgeText,
      "Query.livingStandard",
      { location: "Berlin" },
      chainedTools,
    );
    assert.equal(data.lifeExpectancy, 82);
  });

  test("geocode receives input params", async () => {
    let geoParams: Record<string, any> = {};
    const spy = async (params: any) => {
      geoParams = params;
      return chainedTools["hereapi.geocode"](params);
    };

    await run(
      bridgeText,
      "Query.livingStandard",
      { location: "Berlin" },
      {
        ...chainedTools,
        "hereapi.geocode": spy,
      },
    );

    assert.equal(geoParams.q, "Berlin");
  });

  test("companyX receives chained geocode output", async () => {
    let cxParams: Record<string, any> = {};
    const spy = async (params: any) => {
      cxParams = params;
      return chainedTools["companyX.getLivingStandard"](params);
    };

    await run(
      bridgeText,
      "Query.livingStandard",
      { location: "Berlin" },
      {
        ...chainedTools,
        "companyX.getLivingStandard": spy,
      },
    );

    assert.equal(cxParams.x, 52.53);
    assert.equal(cxParams.y, 13.38);
  });
});
