---
title: Array Operation
description: Http client
---

| Tool         | Input                          | Output                | Description                                                                                                    |
| ------------ | ------------------------------ | --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `findObject` | `{ in: any[], ...criteria }`   | `object \| undefined` | Finds the first object in `in` where all criteria match.                                                       |
| `pickFirst`  | `{ in: any[], strict?: bool }` | `any`                 | Returns the first array element. With `strict = true`, throws if the array is empty or has more than one item. |
| `toArray`    | `{ in: any }`                  | `any[]`               | Wraps a single value in an array. Returns as-is if already an array.                                           |
