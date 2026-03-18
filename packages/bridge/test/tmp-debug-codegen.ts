import { bridge, parseBridgeFormat } from "@stackables/bridge";
import { compileBridge } from "@stackables/bridge-compiler";

function show(name: string, source: string, operation: string) {
  const doc = parseBridgeFormat(source);
  const result = compileBridge(doc, { operation });
  console.log(`\n=== ${name} (${operation}) ===`);
  console.log(result.functionBody);
}

show(
  "Overdefinition",
  bridge`
    version 1.5

    bridge Overdef.lookup {
      with test.multitool as api
      with test.multitool as a
      with test.multitool as b
      with context as ctx
      with input as i
      with output as o

      api <- i.api
      a <- i.a
      b <- i.b

      o.inputBeats <- api.label
      o.inputBeats <- i.hint

      o.contextBeats <- api.label
      o.contextBeats <- ctx.defaultLabel

      o.sameCost <- a.label
      o.sameCost <- b.label
    }
`,
  "Overdef.lookup",
);

show(
  "SyncAsync",
  bridge`
    version 1.5

    bridge SyncAsync.lookup {
      with test.async.multitool as slow
      with test.sync.multitool as fast
      with input as i
      with output as o

      slow <- i.data
      fast <- i.data

      o.label <- slow.label
      o.label <- fast.label
    }
`,
  "SyncAsync.lookup",
);
