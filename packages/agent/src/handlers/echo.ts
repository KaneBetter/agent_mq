// echo: returns the payload verbatim (treated as untrusted, opaque data — never executed/interpreted).
import type { Handler } from "./types.js";

export const echo: Handler = async (task) => {
  return {
    result: { echoed: task.payload },
    metrics: { tokens: { input: 0, output: 0, total: 0 } },
  };
};
