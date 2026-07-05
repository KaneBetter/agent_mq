// Mock LLM handlers: fabricate plausible text output + realistic-ish token
// counts so the demo works with zero external keys. Real integrations would
// swap these for calls through the server's egress proxy (see design doc §12).
import { runMockLlm } from "./mock-llm.js";
import type { Handler } from "./types.js";

export const webResearch: Handler = async (task) =>
  runMockLlm(task, {
    label: "Research summary",
    sentenceRange: [4, 8],
    tokensPerSentence: [18, 32],
    sleepRangeMs: [800, 2600],
  });

export const summarizeDoc: Handler = async (task) =>
  runMockLlm(task, {
    label: "Document summary",
    sentenceRange: [2, 5],
    tokensPerSentence: [14, 24],
    sleepRangeMs: [500, 1800],
  });

export const draftArticle: Handler = async (task) =>
  runMockLlm(task, {
    label: "Draft article",
    sentenceRange: [6, 12],
    tokensPerSentence: [20, 36],
    sleepRangeMs: [1200, 3200],
  });

export const translateText: Handler = async (task) =>
  runMockLlm(task, {
    label: "Translation",
    sentenceRange: [2, 6],
    tokensPerSentence: [16, 26],
    sleepRangeMs: [400, 1500],
  });
