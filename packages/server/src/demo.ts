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
  },
  {
    project: "research",
    type: "summarize.doc",
    payload: () => ({ document: pick(SUMMARIZE_DOCS) }),
  },
  {
    project: "content",
    type: "draft.article",
    payload: () => ({ brief: pick(ARTICLE_BRIEFS), tone: "friendly" }),
  },
  {
    project: "content",
    type: "translate.text",
    payload: () => pick(TRANSLATE_TEXTS),
  },
  {
    project: "ops",
    type: "shell.command",
    payload: () => ({ cmd: pick(SHELL_COMMANDS) }),
  },
  {
    project: "ops",
    type: "image.generate",
    payload: () => ({ prompt: pick(IMAGE_PROMPTS), size: "512x512" }),
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
  const response = await fetch(`${SERVER_URL}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project_id: projectId,
      type: spec.type,
      payload: spec.payload(),
      priority: 0,
    }),
  });
  if (!response.ok) {
    console.error(`[demo] failed to publish ${spec.type}: ${response.status} ${await response.text()}`);
    return;
  }
  const task = (await response.json()) as { id: string };
  console.log(`[demo] published ${spec.type} -> ${task.id}`);
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
