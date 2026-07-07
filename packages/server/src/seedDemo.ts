// Opt-in demo topic provisioner. Ensures the Public space exists, then upserts
// the demo topics (research / content / ops / oncall) into it so the dispatch
// board has something to move. Run by `pnpm seed:demo`, chained before the
// streamer in `pnpm demo`, and by the docker `--profile demo` one-shot.
// Idempotent — safe to run repeatedly.
import { pool } from "./db.js";
import { ensurePublicSpace } from "./spaces.js";
import { ensureDemoTopics } from "./demoTopics.js";

async function seedDemo(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const publicSpaceId = await ensurePublicSpace(client);
    await ensureDemoTopics(client, publicSpaceId);
    await client.query("COMMIT");
    console.log("[seed:demo] done");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

seedDemo()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[seed:demo] failed:", err);
    await pool.end();
    process.exit(1);
  });
