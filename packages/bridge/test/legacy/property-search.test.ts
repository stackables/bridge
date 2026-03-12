import assert from "node:assert/strict";
import { test } from "node:test";
import { forEachEngine } from "../utils/dual-run.ts";

const bridgeFile = `version 1.5

# Property search — all patterns in one API
#
# Resolves backwards from demand:
#   listings/topPick ← zillow ← hereapi ← user input
bridge Query.propertySearch {
  with hereapi.geocode as gc
  with zillow.search as z
  with input as i
  with centsToUsd as usd
  with output as o

  # passthrough: explicit input → output
  o.location <- i.location

  # user input → hereapi (rename: location → q)
  gc.q <- i.location

  # chained: hereapi output → zillow input
  z.latitude <- gc.items[0].position.lat
  z.longitude <- gc.items[0].position.lng

  # user input → zillow (rename: budget → maxPrice)
  z.maxPrice <- i.budget

  # topPick: first result, nested drill + rename + tool
  o.topPick.address <- z.properties[0].streetAddress
  o.topPick.bedrooms <- z.properties[0].beds
  o.topPick.city <- z.properties[0].location.city

  usd.cents <- z.properties[0].priceInCents
  o.topPick.price <- usd.dollars

  # listings: array mapping with per-element rename + nested drill
  o.listings <- z.properties[] as prop {
    .address <- prop.streetAddress
    .price <- prop.priceInCents
    .bedrooms <- prop.beds
    .city <- prop.location.city
  }

}

# Property comments — chained providers + scalar array via tool
#
# Resolves: comments ← pluckText ← reviews ← hereapi ← user input
bridge Query.propertyComments {
  with hereapi.geocode as gc
  with reviews.getByLocation as rv
  with input as i
  with pluckText as pt
  with output as o

  # user input → hereapi
  gc.q <- i.location

  # chained: hereapi → reviews
  rv.lat <- gc.items[0].position.lat
  rv.lng <- gc.items[0].position.lng

  # reviews.comments piped through pluckText → flat string array
  # pipe shorthand: wires rv.comments → pt.in, pt.out → propertyComments
  o.propertyComments <- pt:rv.comments

}
`;

const propertyTools: Record<string, any> = {
  "hereapi.geocode": async (_params: any) => ({
    items: [
      {
        title: "Berlin",
        position: { lat: 52.53, lng: 13.38 },
      },
    ],
  }),
  "zillow.search": async (_params: any) => ({
    properties: [
      {
        streetAddress: "123 Main St",
        priceInCents: 35000000,
        beds: 3,
        location: { city: "Berlin" },
      },
      {
        streetAddress: "456 Oak Ave",
        priceInCents: 42000000,
        beds: 4,
        location: { city: "Berlin" },
      },
    ],
  }),
  "reviews.getByLocation": async (_params: any) => ({
    comments: [
      { text: "Great neighborhood", rating: 5 },
      { text: "Quiet area", rating: 4 },
    ],
  }),
  centsToUsd: (params: { cents: number }) => ({ dollars: params.cents / 100 }),
  pluckText: (params: { in: any[] }) => params.in.map((item: any) => item.text),
};

forEachEngine("property search (.bridge file)", (run) => {
  test("passthrough: location echoed", async () => {
    const { data } = await run(
      bridgeFile,
      "Query.propertySearch",
      { location: "Berlin" },
      propertyTools,
    );
    assert.equal(data.location, "Berlin");
  });

  test("topPick: chained geocode → zillow → tool", async () => {
    const { data } = await run(
      bridgeFile,
      "Query.propertySearch",
      { location: "Berlin" },
      propertyTools,
    );
    const topPick = data.topPick;
    assert.equal(topPick.address, "123 Main St");
    assert.equal(topPick.price, 350000); // 35000000 / 100
    assert.equal(topPick.bedrooms, 3);
    assert.equal(topPick.city, "Berlin");
  });

  test("listings: array mapping with per-element rename", async () => {
    const { data } = await run(
      bridgeFile,
      "Query.propertySearch",
      { location: "Berlin" },
      propertyTools,
    );
    const listings = data.listings;
    assert.equal(listings.length, 2);
    assert.equal(listings[0].address, "123 Main St");
    assert.equal(listings[0].price, 35000000); // raw value, no tool on listings
    assert.equal(listings[1].address, "456 Oak Ave");
    assert.equal(listings[1].bedrooms, 4);
    assert.equal(listings[1].city, "Berlin");
  });

  test("propertyComments: chained tools + pluckText tool", async () => {
    const { data } = await run(
      bridgeFile,
      "Query.propertyComments",
      { location: "Berlin" },
      propertyTools,
    );
    assert.deepStrictEqual(data.propertyComments, [
      "Great neighborhood",
      "Quiet area",
    ]);
  });

  test("zillow receives chained geocode coordinates", async () => {
    let zillowParams: Record<string, any> = {};
    const spy = async (params: any) => {
      zillowParams = params;
      return propertyTools["zillow.search"](params);
    };

    await run(
      bridgeFile,
      "Query.propertySearch",
      { location: "Berlin" },
      { ...propertyTools, "zillow.search": spy },
    );

    assert.equal(zillowParams.latitude, 52.53);
    assert.equal(zillowParams.longitude, 13.38);
  });
});
