---
title: File Structure 
description: The Bridge Language — Definitive Guide
---



A `.bridge` file starts with a version declaration and contains one or more
blocks:

```bridge
version 1.4

const defaultCurrency = "EUR"

tool hereGeo from httpCall {
  .baseUrl = "https://geocode.search.hereapi.com/v1"
  .method = GET
  .path = /geocode
}

bridge Query.getWeather {
  with hereGeo as geo
  with input as i
  with output as o

  geo.q <- i.cityName
  o.lat <- geo.items[0].position.lat
  o.lon <- geo.items[0].position.lng
}
```

Blocks are separated by blank lines. Comments start with `#`.
