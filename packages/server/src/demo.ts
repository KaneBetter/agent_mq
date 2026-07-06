// Publishes a rolling stream of demo tasks across the seeded projects/types so
// the live dispatch board visibly fills, then exits. Talks to the running
// server over HTTP (so it exercises the real publish path incl. events).
import "./env.js";

const SERVER_URL = process.env.AGENTMQ_SERVER ?? `http://localhost:${process.env.SERVER_PORT ?? 4000}`;
const TASK_COUNT = 30;
const INTERVAL_MS = 250;

interface DemoTaskSpec {
  project: string;
  type: string;
  payload: () => Record<string, unknown>;
  tagPool: string[];
}

// ~20% of published tasks get a near-future scheduled_for so the calendar's
// upcoming column has data to show.
const SCHEDULED_PROBABILITY = 0.2;
const SCHEDULED_MIN_MS = 2 * 60_000;
const SCHEDULED_MAX_MS = 40 * 60_000;

/** Picks 1-3 random tags from the pool (no duplicates), plain Math.random — one-shot script. */
function pickTags(pool: string[]): string[] {
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  const count = Math.min(pool.length, 1 + Math.floor(Math.random() * 3));
  return shuffled.slice(0, count);
}

function maybeScheduledFor(): string | undefined {
  if (Math.random() >= SCHEDULED_PROBABILITY) return undefined;
  const delayMs = SCHEDULED_MIN_MS + Math.random() * (SCHEDULED_MAX_MS - SCHEDULED_MIN_MS);
  return new Date(Date.now() + delayMs).toISOString();
}

const RESEARCH_URLS = [
  "https://en.wikipedia.org/wiki/Postgresql",
  "https://en.wikipedia.org/wiki/Message_queue",
  "https://en.wikipedia.org/wiki/Distributed_computing",
  "https://en.wikipedia.org/wiki/Task_queue",
];

const SUMMARIZE_DOCS = [
  "Quarterly engineering retro notes covering reliability wins and outstanding tech debt.",
  "Design doc for the new dispatch console, including open questions on auth.",
  "Customer feedback digest from the last two weeks of support tickets.",
];

const ARTICLE_BRIEFS = [
  "Write a short blog post announcing the new agent-mq dispatch console.",
  "Draft a changelog entry for the reaper reliability improvements.",
  "Draft an onboarding guide for new agent operators.",
];

const TRANSLATE_TEXTS = [
  { text: "The task queue processes jobs in FIFO order.", target: "es" },
  { text: "Agents register capabilities before subscribing to a project.", target: "fr" },
];

const SHELL_COMMANDS = ["df -h", "uptime", "echo hello from agent-mq"];

const IMAGE_PROMPTS = [
  "A minimalist dashboard icon representing a task queue.",
  "An abstract network diagram in blue and orange.",
];

function pick<T>(arr: T[]): T {
  const item = arr[Math.floor(Math.random() * arr.length)];
  if (item === undefined) throw new Error("pick() called on empty array");
  return item;
}

const SPECS: DemoTaskSpec[] = [
  {
    project: "research",
    type: "web.research",
    payload: () => ({ url: pick(RESEARCH_URLS), question: "Summarize the key facts." }),
    tagPool: ["llm", "research", "web"],
  },
  {
    project: "research",
    type: "summarize.doc",
    payload: () => ({ document: pick(SUMMARIZE_DOCS) }),
    tagPool: ["llm", "research", "docs"],
  },
  {
    project: "content",
    type: "draft.article",
    payload: () => ({ brief: pick(ARTICLE_BRIEFS), tone: "friendly" }),
    tagPool: ["llm", "writing", "content"],
  },
  {
    project: "content",
    type: "translate.text",
    payload: () => pick(TRANSLATE_TEXTS),
    tagPool: ["llm", "writing", "translate"],
  },
  {
    project: "ops",
    type: "shell.command",
    payload: () => ({ cmd: pick(SHELL_COMMANDS) }),
    tagPool: ["infra", "shell"],
  },
  {
    project: "ops",
    type: "image.generate",
    payload: () => ({ prompt: pick(IMAGE_PROMPTS), size: "512x512" }),
    tagPool: ["infra", "gpu", "image"],
  },
];

interface ProjectDto {
  id: string;
  name: string;
}

async function fetchProjectIds(): Promise<Map<string, string>> {
  const response = await fetch(`${SERVER_URL}/api/projects`);
  if (!response.ok) {
    throw new Error(`Failed to fetch projects: ${response.status} ${await response.text()}`);
  }
  const projects = (await response.json()) as ProjectDto[];
  const byName = new Map<string, string>();
  for (const project of projects) {
    byName.set(project.name, project.id);
  }
  return byName;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function publishTask(projectId: string, spec: DemoTaskSpec): Promise<void> {
  const tags = pickTags(spec.tagPool);
  const scheduledFor = maybeScheduledFor();

  const response = await fetch(`${SERVER_URL}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project_id: projectId,
      type: spec.type,
      payload: spec.payload(),
      priority: 0,
      tags,
      scheduled_for: scheduledFor,
    }),
  });
  if (!response.ok) {
    console.error(`[demo] failed to publish ${spec.type}: ${response.status} ${await response.text()}`);
    return;
  }
  const task = (await response.json()) as { id: string };
  const scheduleNote = scheduledFor ? ` (scheduled for ${scheduledFor})` : "";
  console.log(`[demo] published ${spec.type} -> ${task.id} tags=[${tags.join(",")}]${scheduleNote}`);
}

async function main(): Promise<void> {
  console.log(`[demo] connecting to server at ${SERVER_URL}`);
  const projectIds = await fetchProjectIds();

  if (projectIds.size === 0) {
    throw new Error("No projects found. Run `pnpm seed` before `pnpm demo`.");
  }

  for (let i = 0; i < TASK_COUNT; i++) {
    const spec = pick(SPECS);
    const projectId = projectIds.get(spec.project);
    if (!projectId) {
      console.warn(`[demo] project "${spec.project}" not seeded yet, skipping`);
      continue;
    }
    await publishTask(projectId, spec);
    await sleep(INTERVAL_MS);
  }

  console.log(`[demo] done: published ${TASK_COUNT} tasks`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[demo] failed:", err);
    process.exit(1);
  });
