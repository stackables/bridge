import type { ToolMetadata } from "@stackables/bridge-types";
import type { BridgeDocument } from "./types.ts";
import { internal as builtinInternal } from "./tools/index.ts";

const sourceTool = {
  sync: true,
  trace: false,
  log: false,
} satisfies ToolMetadata;

function collectConstValues(document: BridgeDocument): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const instruction of document.instructions) {
    if (instruction.kind === "const") {
      values[instruction.name] = JSON.parse(instruction.value);
    }
  }
  return values;
}

export function buildInternalToolNamespace(
  document: BridgeDocument,
  input: Record<string, unknown>,
  context: Record<string, unknown>,
  userInternal?: Record<string, any>,
): Record<string, any> {
  const consts = collectConstValues(document);

  const inputTool = () => input;
  inputTool.bridge = sourceTool;

  const contextTool = () => context;
  contextTool.bridge = sourceTool;

  const constsTool = () => consts;
  constsTool.bridge = sourceTool;

  return {
    ...builtinInternal,
    ...(userInternal ?? {}),
    input: inputTool,
    context: contextTool,
    consts: constsTool,
  };
}
