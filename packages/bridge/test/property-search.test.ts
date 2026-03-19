import assert from "node:assert/strict";
import { regressionTest } from "./utils/regression.ts";
import { bridge } from "@stackables/bridge";

// ═══════════════════════════════════════════════════════════════════════════
// Property search — chained tools, array mapping, pipe syntax
//
// Migrated from legacy/property-search.test.ts
// ═══════════════════════════════════════════════════════════════════════════

const propertyTools: Record<string, any> = {
  "hereapi.geocode": async () => ({
    items: [
      {
        title: "Berlin",
        position: { lat: 52.53, lng: 13.38 },
      },
    ],
  }),
  "zillow.search": async () => ({
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
  "reviews.getByLocation": async () => ({
    comments: [
      { text: "Great neighborhood", rating: 5 },
      { text: "Quiet area", rating: 4 },
    ],
  }),
  centsToUsd: (params: { cents: number }) => ({ dollars: params.cents / 100 }),
  pluckText: (params: { in: any[] }) => params.in.map((item: any) => item.text),
};

regressionTest("property search (.bridge file)", {
  bridge: bridge`
    version 1.5

    bridge Query.propertySearch {
      with hereapi.geocode as gc
      with zillow.search as z
      with input as i
      with centsToUsd as usd
      with output as o

      o.location <- i.location
      gc.q <- i.location
      z.latitude <- gc.items[0].position.lat
      z.longitude <- gc.items[0].position.lng
      z.maxPrice <- i.budget

      o.topPick.address <- z.properties[0].streetAddress
      o.topPick.bedrooms <- z.properties[0].beds
      o.topPick.city <- z.properties[0].location.city

      usd.cents <- z.properties[0].priceInCents
      o.topPick.price <- usd.dollars

      o.listings <- z.properties[] as prop {
        .address <- prop.streetAddress
        .price <- prop.priceInCents
        .bedrooms <- prop.beds
        .city <- prop.location.city
      }
    }

    bridge Query.propertyComments {
      with hereapi.geocode as gc
      with reviews.getByLocation as rv
      with input as i
      with pluckText as pt
      with output as o

      gc.q <- i.location
      rv.lat <- gc.items[0].position.lat
      rv.lng <- gc.items[0].position.lng
      o.propertyComments <- pt:rv.comments
    }
  `,
  tools: propertyTools,
  scenarios: {
    "Query.propertySearch": {
      "passthrough: location echoed": {
        input: { location: "Berlin" },
        assertData: { location: "Berlin" },
        assertTraces: 3,
      },
      "topPick: chained geocode → zillow → centsToUsd": {
        input: { location: "Berlin" },
        assertData: {
          topPick: {
            address: "123 Main St",
            price: 350000,
            bedrooms: 3,
            city: "Berlin",
          },
        },
        assertTraces: 3,
      },
      "listings: array mapping with per-element rename": {
        input: { location: "Berlin" },
        assertData: (data: any) => {
          const listings = data.listings;
          assert.equal(listings.length, 2);
          assert.equal(listings[0].address, "123 Main St");
          assert.equal(listings[0].price, 35000000);
          assert.equal(listings[1].address, "456 Oak Ave");
          assert.equal(listings[1].bedrooms, 4);
          assert.equal(listings[1].city, "Berlin");
        },
        assertTraces: 3,
      },
      "empty listings: array source returns empty": {
        input: { location: "Berlin" },
        fields: ["listings"],
        tools: {
          ...propertyTools,
          "zillow.search": async () => ({ properties: [] }),
        },
        assertData: { listings: [] },
        assertTraces: 2,
      },
    },
    "Query.propertyComments": {
      "chained tools + pluckText pipe": {
        input: { location: "Berlin" },
        assertData: {
          propertyComments: ["Great neighborhood", "Quiet area"],
        },
        assertTraces: 3,
      },
    },
  },
});
