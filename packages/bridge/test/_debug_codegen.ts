import { parseBridgeFormat as parseBridge } from "../../bridge/src/index.ts";
import { compileBridge } from "@stackables/bridge-compiler";

const src = `version 1.5

bridge Query.safeRightAnd {
  with input as i
  with failingApi as api
  with output as o

  api.in <- i.value
  o.result <- i.flag and api?.active
}
`;

const parsed = parseBridge(src);
for (const b of parsed.instructions) {
  const op = `${(b as any).type}.${(b as any).field}`;
  try {
    const code = compileBridge(parsed, { operation: op });
    console.log(`=== ${op} ===`);
    console.log(code.code);
  } catch (e: any) {
    console.log(`=== ${op} === FAILED: ${e.message}`);
  }
}
