import type { ToolContext } from "@stackables/bridge-types";
import { setTimeout } from "node:timers/promises";

/**
 * removes all _ keys from input
 * @param input
 */
function cleanupInstructions(input: Record<string, any>): Record<string, any> {
  if (Array.isArray(input)) {
    return input.map((item) =>
      typeof item === "object" && item !== null
        ? cleanupInstructions(item)
        : item,
    ) as any;
  }
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key.startsWith("_")) continue;
    if (Array.isArray(value)) {
      result[key] = cleanupInstructions(value);
    } else if (typeof value === "object" && value !== null) {
      result[key] = cleanupInstructions(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function syncMultitool(input: Record<string, any>, _context: ToolContext) {
  if (input?._error) {
    throw new Error(String(input._error));
  }
  return cleanupInstructions(input);
}
syncMultitool.bridge = {
  sync: true,
};

async function multitool(input: Record<string, any>, context: ToolContext) {
  if (input._delay) {
    await setTimeout(input._delay, true, {
      signal: input._signal ?? context.signal,
    });
  }
  return syncMultitool(input, context);
}

async function batchMultitool(
  input: Array<Record<string, any>>,
  context: ToolContext,
) {
  return Promise.all(
    input.map((item) => multitool(item, context).catch((err) => err)),
  );
}
batchMultitool.bridge = {
  batch: true,
  log: { execution: "info" },
};

function cheapMultitool(input: Record<string, any>, _context: ToolContext) {
  if (input?._error) {
    throw new Error(String(input._error));
  }
  return cleanupInstructions(input);
}
cheapMultitool.bridge = {
  sync: true,
  cost: 0,
};

export const tools = {
  test: {
    multitool: (a: any, c: ToolContext) => {
      // pick a random tool as all must work
      const variants = [multitool, syncMultitool];
      const tool = variants[Math.floor(Math.random() * variants.length)];
      return tool(a, c);
    },
    async: {
      multitool: multitool,
    },
    sync: {
      multitool: syncMultitool,
    },
    batch: {
      multitool: batchMultitool,
    },
    cheap: {
      multitool: cheapMultitool,
    },
  },
};

function toolToolCallsMade() {}

export const assert = {
  toolToolCallsMade,
};
