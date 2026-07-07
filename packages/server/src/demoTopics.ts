// Demo topics (research / content / ops / oncall) plus their task types and the
// on-call roster schedule. NOT part of the default seed — the default Public
// space ships empty. These are provisioned on demand by the demo flows
// (`pnpm seed:demo`, `pnpm demo`, and the docker `--profile demo` worker) so the
// dispatch board has something to move. Idempotent: safe to run repeatedly.
import type { PoolClient } from "pg";
import type { Recurrence } from "@agentmq/shared";
import { nextRun } from "./scheduling.js";

interface DemoTopic {
  name: string;
  description: string;
  tags: string[];
  taskTypes: Array<{
    type: string;
    description: string;
    requiredCapabilities: string[];
  }>;
}

const DEMO_TOPICS: DemoTopic[] = [
  {
    name: "research",
    description: "Web research and document summarization tasks.",
    tags: ["llm", "research"],
    taskTypes: [
      {
        type: "web.research",
        description: "Research a topic or URL and produce findings.",
        requiredCapabilities: [],
      },
      {
        type: "summarize.doc",
        description: "Summarize a document into key points.",
        requiredCapabilities: [],
      },
    ],
  },
  {
    name: "content",
    description: "Content drafting and translation tasks.",
    tags: ["llm", "writing"],
    taskTypes: [
      {
        type: "draft.article",
        description: "Draft an article from a brief.",
        requiredCapabilities: [],
      },
      {
        type: "translate.text",
        description: "Translate text between languages.",
        requiredCapabilities: [],
      },
    ],
  },
  {
    name: "ops",
    description: "Operational tasks requiring special capabilities.",
    tags: ["infra", "gpu"],
    taskTypes: [
      {
        type: "shell.command",
        description: "Run a shell command on a capable agent.",
        requiredCapabilities: ["shell"],
      },
      {
        type: "image.generate",
        description: "Generate an image using a GPU-backed model.",
        requiredCapabilities: ["gpu"],
      },
    ],
  },
  {
    name: "oncall",
    description: "On-call duty roster and shift-driven tasks.",
    tags: ["ops", "duty"],
    taskTypes: [
      {
        type: "oncall.shift",
        description: "A scheduled on-call duty shift.",
        requiredCapabilities: [],
      },
    ],
  },
];

const ROSTER_SCHEDULE_NAME = "Weekday duty roster";
const ROSTER_RECURRENCE: Recurrence = {
  kind: "weekly",
  days_of_week: [1, 2, 3, 4, 5],
  times: ["00:00", "06:00", "12:00", "18:00"],
  timezone: "UTC",
};

/**
 * Upserts the demo topics into the given space, each with a `default` group, its
 * task types, and (for `oncall`) the weekday duty roster schedule. Runs inside
 * the caller's transaction; every write is ON CONFLICT-safe so re-runs no-op.
 */
export async function ensureDemoTopics(
  client: PoolClient,
  spaceId: string
): Promise<void> {
  for (const topic of DEMO_TOPICS) {
    const projectResult = await client.query<{ id: string }>(
      `INSERT INTO projects (name, description, tags, space_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (name) DO UPDATE SET
         description = EXCLUDED.description,
         tags        = CASE WHEN projects.tags = '{}' THEN EXCLUDED.tags ELSE projects.tags END,
         space_id    = COALESCE(projects.space_id, EXCLUDED.space_id)
       RETURNING id`,
      [topic.name, topic.description, topic.tags, spaceId]
    );
    const projectId = projectResult.rows[0]?.id;
    if (!projectId) {
      throw new Error(`Failed to upsert demo topic ${topic.name}`);
    }

    await client.query(
      `INSERT INTO groups (name, project_id) VALUES ('default', $1)
       ON CONFLICT (project_id, name) DO NOTHING`,
      [projectId]
    );

    for (const taskType of topic.taskTypes) {
      await client.query(
        `INSERT INTO task_types (type, description, required_capabilities)
         VALUES ($1, $2, $3)
         ON CONFLICT (type) DO UPDATE SET
           description = EXCLUDED.description,
           required_capabilities = EXCLUDED.required_capabilities`,
        [taskType.type, taskType.description, taskType.requiredCapabilities]
      );
    }

    if (topic.name === "oncall") {
      const existingSchedule = await client.query<{ id: string }>(
        `SELECT id FROM schedules WHERE project_id = $1 AND name = $2`,
        [projectId, ROSTER_SCHEDULE_NAME]
      );
      if (!existingSchedule.rows[0]) {
        const nextRunAt = nextRun(ROSTER_RECURRENCE, new Date());
        await client.query(
          `INSERT INTO schedules
             (project_id, name, type, payload_template, tags, required_capabilities,
              recurrence, shift_hours, enabled, next_run_at)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb, $8, true, $9)`,
          [
            projectId,
            ROSTER_SCHEDULE_NAME,
            "oncall.shift",
            JSON.stringify({ role: "primary" }),
            [],
            [],
            JSON.stringify(ROSTER_RECURRENCE),
            6,
            nextRunAt.toISOString(),
          ]
        );
        console.log(`[seed:demo] schedule "${ROSTER_SCHEDULE_NAME}" created for topic "oncall"`);
      }
    }

    console.log(`[seed:demo] topic "${topic.name}" ready (${topic.taskTypes.length} task types, default group)`);
  }
}
