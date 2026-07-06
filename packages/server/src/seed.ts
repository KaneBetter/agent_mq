// Idempotent demo data: projects + task types + default groups.
// Safe to run repeatedly (ON CONFLICT DO NOTHING / upsert semantics throughout).
import type { Recurrence } from "@agentmq/shared";
import { pool } from "./db.js";
import { nextRun } from "./scheduling.js";

interface ProjectSeed {
  name: string;
  description: string;
  tags: string[];
  taskTypes: Array<{
    type: string;
    description: string;
    requiredCapabilities: string[];
  }>;
}

const PROJECTS: ProjectSeed[] = [
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

async function seed(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const project of PROJECTS) {
      await client.query("BEGIN");

      const projectResult = await client.query<{ id: string }>(
        `INSERT INTO projects (name, description, tags)
         VALUES ($1, $2, $3)
         ON CONFLICT (name) DO UPDATE SET
           description = EXCLUDED.description,
           tags        = CASE WHEN projects.tags = '{}' THEN EXCLUDED.tags ELSE projects.tags END
         RETURNING id`,
        [project.name, project.description, project.tags]
      );
      const projectId = projectResult.rows[0]?.id;

      if (!projectId) {
        await client.query("ROLLBACK");
        throw new Error(`Failed to upsert project ${project.name}`);
      }

      await client.query(
        `INSERT INTO groups (name, project_id) VALUES ('default', $1)
         ON CONFLICT (project_id, name) DO NOTHING`,
        [projectId]
      );

      for (const taskType of project.taskTypes) {
        await client.query(
          `INSERT INTO task_types (type, description, required_capabilities)
           VALUES ($1, $2, $3)
           ON CONFLICT (type) DO UPDATE SET
             description = EXCLUDED.description,
             required_capabilities = EXCLUDED.required_capabilities`,
          [taskType.type, taskType.description, taskType.requiredCapabilities]
        );
      }

      if (project.name === "oncall") {
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
          console.log(`[seed] schedule "${ROSTER_SCHEDULE_NAME}" created for project "oncall"`);
        } else {
          console.log(`[seed] schedule "${ROSTER_SCHEDULE_NAME}" already exists, skipping`);
        }
      }

      await client.query("COMMIT");
      console.log(`[seed] project "${project.name}" ready (${project.taskTypes.length} task types, default group)`);
    }

    console.log("[seed] done");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

seed()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[seed] failed:", err);
    await pool.end();
    process.exit(1);
  });
