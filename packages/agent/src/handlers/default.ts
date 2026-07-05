// Default handler for unknown task types: a safe generic mock that echoes
// back a redacted view of the payload and reports zero tokens. Never executes
// or interprets payload contents.
import type { Handler } from "./types.js";

export const defaultHandler: Handler = async (task) => {
  return {
    result: {
      note: `no handler registered for task type "${task.type}"; generic mock response`,
      payload_keys: Object.keys(task.payload ?? {}),
    },
    metrics: { tokens: { input: 0, output: 0, total: 0 } },
  };
};
