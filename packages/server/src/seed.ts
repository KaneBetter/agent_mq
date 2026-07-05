// Idempotent demo data: projects + task types + default groups.
// Safe to run repeatedly (ON CONFLICT DO NOTHING / upsert semantics throughout).
import { pool } from "./db.js";

interface ProjectSeed {
  name: string;
  description: string;
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
];

async function seed(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const project of PROJECTS) {
      await client.query("BEGIN");

      const projectResult = await client.query<{ id: string }>(
        `INSERT INTO projects (name, description)
         VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description
         RETURNING id`,
        [project.name, project.description]
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
