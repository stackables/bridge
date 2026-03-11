/**
 * removes all _ keys from input
 * @param input
 */
function cleanupInstructions(input: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key.startsWith("_")) continue;
    if (typeof value === "object" && value !== null) {
      result[key] = cleanupInstructions(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export const tools = {
  test: {
    multitool: (input: Record<string, any>) => {
      if (input?._error) {
        throw new Error(String(input._error));
      }
      return cleanupInstructions(input);
    },
    async: {
      multitool: async (input: Record<string, any>) => {
        if (input._delay) {
          await new Promise((resolve) => setTimeout(resolve, input._delay));
        }
        if (input?._error) {
          throw new Error(String(input._error));
        }
        return cleanupInstructions(input);
      },
    },
  },
};

function toolToolCallsMade() {}

export const assert = {
  toolToolCallsMade,
};
