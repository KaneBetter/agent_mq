// Handler registry: task.type -> Handler. New task types are added here by
// registering a new entry; unregistered types fall back to `defaultHandler`.
import { defaultHandler } from "./default.js";
import { echo } from "./echo.js";
import { imageGenerate } from "./image-generate.js";
import { draftArticle, summarizeDoc, translateText, webResearch } from "./llm-handlers.js";
import { shellCommand } from "./shell-command.js";
import { sleep } from "./sleep.js";
import type { Handler } from "./types.js";

export const handlers: Map<string, Handler> = new Map<string, Handler>([
  ["echo", echo],
  ["sleep", sleep],
  ["web.research", webResearch],
  ["summarize.doc", summarizeDoc],
  ["draft.article", draftArticle],
  ["translate.text", translateText],
  ["image.generate", imageGenerate],
  ["shell.command", shellCommand],
]);

/** Look up a handler by task type, falling back to the generic default mock. */
export function resolveHandler(type: string): Handler {
  return handlers.get(type) ?? defaultHandler;
}

export type { Handler, HandlerContext, HandlerOutcome } from "./types.js";
