// Default seed: the demo user + the single "Public" space (renaming any legacy
// public space into it) + the demo user's private space. The Public space ships
// EMPTY — no topics. Demo topics live in `demoTopics.ts` and are provisioned
// separately by the demo flows (`pnpm seed:demo` / `pnpm demo` / docker
// `--profile demo`). Safe to run repeatedly (upsert / ON CONFLICT semantics).
import { pool } from "./db.js";
import { hashPassword } from "./userAuth.js";
import { ensurePrivateSpace, ensurePublicSpace } from "./spaces.js";

const DEMO_USERNAME = "demo";
const DEMO_PASSWORD = "demo";
const PUBLIC_SPACE_NAME = "Public";

/**
 * Seeds the demo user (demo/demo), ensures the single Public space (renaming
 * the legacy "Demo Space" into it if that's the space the unique index found),
 * and gives demo their own private space via the shared auto-create path.
 */
async function seedDemoUserAndSpaces(
  client: import("pg").PoolClient
): Promise<{ userId: string; publicSpaceId: string; privateSpaceId: string }> {
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

  // ensurePublicSpace() finds the existing public space if one already exists
  // (e.g. the old "Demo Space", which was seeded as visibility='public') and
  // never inserts a second row (spaces_single_public_uidx enforces this).
  const publicSpaceId = await ensurePublicSpace(client);
  const publicSpaceRow = await client.query<{ name: string }>(
    `SELECT name FROM spaces WHERE id = $1`,
    [publicSpaceId]
  );
  if (publicSpaceRow.rows[0]?.name !== PUBLIC_SPACE_NAME) {
    await client.query(`UPDATE spaces SET name = $1 WHERE id = $2`, [
      PUBLIC_SPACE_NAME,
      publicSpaceId,
    ]);
    console.log(
      `[seed] renamed public space "${publicSpaceRow.rows[0]?.name}" -> "${PUBLIC_SPACE_NAME}"`
    );
  } else {
    console.log(`[seed] "${PUBLIC_SPACE_NAME}" space already in place, skipping`);
  }

  await client.query(
    `INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'admin')
     ON CONFLICT (space_id, user_id) DO NOTHING`,
    [publicSpaceId, userId]
  );

  const privateSpaceId = await ensurePrivateSpace(client, userId, "Demo User");

  return { userId, publicSpaceId, privateSpaceId };
}

const SITE_UPDATES: Array<{ title: string; body: string; category: string }> = [
  {
    title: "agent-mq 0.1 — the dispatch console is live",
    body: "Publish tasks from the console; consumers pull them, run them, and report results + token usage back to the live board.",
    category: "release",
  },
  {
    title: "Consumer lifecycle: connect → apply → register → subscribe",
    body: "Each step installs its own poll: a 24h site-update read on connect, a 24h space poll on register, and a 1h topic poll when you subscribe a consumer. Applying to a space creates no schedule.",
    category: "announcement",
  },
  {
    title: "Reliability: reaper reclaims work from slept machines",
    body: "Lease + heartbeat with an advisory-lock leader-elected reaper. A poison task backs off via visible_after so it can't jam the queue head.",
    category: "release",
  },
];

/** Seeds the news timeline once (only when empty, so re-runs don't duplicate). */
async function seedSiteUpdates(client: import("pg").PoolClient): Promise<void> {
  const existing = await client.query<{ count: string }>(`SELECT count(*) FROM site_updates`);
  if (Number(existing.rows[0]?.count ?? 0) > 0) {
    console.log(`[seed] site updates already present, skipping`);
    return;
  }
  for (const update of SITE_UPDATES) {
    await client.query(
      `INSERT INTO site_updates (title, body, category) VALUES ($1, $2, $3)`,
      [update.title, update.body, update.category]
    );
  }
  console.log(`[seed] seeded ${SITE_UPDATES.length} site updates (news timeline)`);
}

/** Any topic with space_id IS NULL is attached to the Public space (legacy backfill). */
async function backfillOrphanTopics(
  client: import("pg").PoolClient,
  spaceId: string
): Promise<void> {
  const result = await client.query<{ id: string }>(
    `UPDATE projects SET space_id = $1 WHERE space_id IS NULL RETURNING id`,
    [spaceId]
  );
  if (result.rows.length > 0) {
    console.log(`[seed] backfilled ${result.rows.length} orphan topic(s) into "${PUBLIC_SPACE_NAME}"`);
  } else {
    console.log(`[seed] no orphan topics to backfill`);
  }
}

async function seed(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { publicSpaceId } = await seedDemoUserAndSpaces(client);
    await backfillOrphanTopics(client, publicSpaceId);
    await seedSiteUpdates(client);
    await client.query("COMMIT");
    console.log("[seed] done (Public space ships empty — run `pnpm seed:demo` for demo topics)");
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
