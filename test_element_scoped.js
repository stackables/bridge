import { parseBridgeFormat } from '@stackables/bridge-parser';

const bridgeText = `version 1.5
bridge Query.test {
  with input as i
  with output as o

  o.items <- i.list[] as item {
    with myTool as t

    t.id <- item.id
    .result <- t.data
  }
}`;

const doc = parseBridgeFormat(bridgeText);
console.log('=== BRIDGE DOCUMENT ===');
console.log(JSON.stringify(doc, null, 2));

const bridge = doc.instructions.find(i => i.kind === 'bridge');
if (bridge) {
  console.log('\n=== BRIDGE HANDLES ===');
  console.log(JSON.stringify(bridge.handles, null, 2));
  
  console.log('\n=== BRIDGE WIRES ===');
  bridge.wires.forEach((w, idx) => {
    console.log(`\nWire ${idx}:`);
    console.log(JSON.stringify(w, null, 2));
  });

  if (bridge.pipeHandles?.length > 0) {
    console.log('\n=== PIPE HANDLES ===');
    console.log(JSON.stringify(bridge.pipeHandles, null, 2));
  }
}
