// Idempotent demo data: projects + task types + default groups, plus (v5) a
// demo user + public "Demo Space" that backfilled/legacy topics attach to.
// Safe to run repeatedly (ON CONFLICT DO NOTHING / upsert semantics throughout).
import type { Recurrence } from "@agentmq/shared";
import { pool } from "./db.js";
import { nextRun } from "./scheduling.js";
import { hashPassword } from "./userAuth.js";

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

const DEMO_USERNAME = "demo";
const DEMO_PASSWORD = "demo";
const DEMO_SPACE_NAME = "Demo Space";
const DEMO_SPACE_SLUG = "demo-space";

/** Seeds the demo user (demo/demo) and a public "Demo Space" owned by them. */
async function seedDemoUserAndSpace(
  client: import("pg").PoolClient
): Promise<{ userId: string; spaceId: string }> {
  const existingUser = await client.query<{ id: string }>(
    `SELECT id FROM users WHERE username = $1`,
    [DEMO_USERNAME]
  );
  let userId = existingUser.rows[0]?.id;
  if (!userId) {
    const passwordHash = hashPassword(DEMO_PASSWORD);
    const userResult = await client.query<{ id: string }>(
      `INSERT INTO users (username, password_hash, display_name)
       VALUES ($1, $2, $3) RETURNING id`,
      [DEMO_USERNAME, passwordHash, "Demo User"]
    );
    userId = userResult.rows[0]?.id;
    console.log(`[seed] demo user "${DEMO_USERNAME}" created (password: ${DEMO_PASSWORD})`);
  } else {
    console.log(`[seed] demo user "${DEMO_USERNAME}" already exists, skipping`);
  }
  if (!userId) {
    throw new Error("Failed to seed demo user");
  }

  const existingSpace = await client.query<{ id: string }>(
    `SELECT id FROM spaces WHERE slug = $1`,
    [DEMO_SPACE_SLUG]
  );
  let spaceId = existingSpace.rows[0]?.id;
  if (!spaceId) {
    const spaceResult = await client.query<{ id: string }>(
      `INSERT INTO spaces (name, slug, visibility, owner_id)
       VALUES ($1, $2, 'public', $3) RETURNING id`,
      [DEMO_SPACE_NAME, DEMO_SPACE_SLUG, userId]
    );
    spaceId = spaceResult.rows[0]?.id;
    console.log(`[seed] "${DEMO_SPACE_NAME}" (public) created, owned by "${DEMO_USERNAME}"`);
  } else {
    console.log(`[seed] "${DEMO_SPACE_NAME}" already exists, skipping`);
  }
  if (!spaceId) {
    throw new Error("Failed to seed demo space");
  }

  await client.query(
    `INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'admin')
     ON CONFLICT (space_id, user_id) DO NOTHING`,
    [spaceId, userId]
  );

  return { userId, spaceId };
}

/** Any topic with space_id IS NULL is attached to the demo space (legacy backfill). */
async function backfillOrphanTopics(
  client: import("pg").PoolClient,
  spaceId: string
): Promise<void> {
  const result = await client.query<{ id: string }>(
    `UPDATE projects SET space_id = $1 WHERE space_id IS NULL RETURNING id`,
    [spaceId]
  );
  if (result.rows.length > 0) {
    console.log(`[seed] backfilled ${result.rows.length} orphan topic(s) into "${DEMO_SPACE_NAME}"`);
  } else {
    console.log(`[seed] no orphan topics to backfill`);
  }
}

async function seed(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { spaceId } = await seedDemoUserAndSpace(client);
    await backfillOrphanTopics(client, spaceId);
    await client.query("COMMIT");

    for (const project of PROJECTS) {
      await client.query("BEGIN");

      const projectResult = await client.query<{ id: string }>(
        `INSERT INTO projects (name, description, tags, space_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (name) DO UPDATE SET
           description = EXCLUDED.description,
           tags        = CASE WHEN projects.tags = '{}' THEN EXCLUDED.tags ELSE projects.tags END,
           space_id    = COALESCE(projects.space_id, EXCLUDED.space_id)
         RETURNING id`,
        [project.name, project.description, project.tags, spaceId]
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
