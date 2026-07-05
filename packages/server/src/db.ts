// Postgres access layer: a shared Pool, a `query` helper, and a `withTx` helper.
import pg from "pg";
import { env } from "./env.js";

const { Pool, types } = pg;

// Contract: timestamps serialize as ISO strings, money as numbers.
// pg defaults: timestamptz -> Date, numeric -> string. Normalize at the driver level
// so every call site gets consistent JS types without per-route conversion.
const TIMESTAMPTZ_OID = 1184;
const TIMESTAMP_OID = 1114;
const NUMERIC_OID = 1700;

types.setTypeParser(TIMESTAMPTZ_OID, (value: string) =>
  value === null ? null : new Date(value).toISOString()
);
types.setTypeParser(TIMESTAMP_OID, (value: string) =>
  value === null ? null : new Date(value).toISOString()
);
types.setTypeParser(NUMERIC_OID, (value: string) =>
  value === null ? null : Number(value)
);

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
});

pool.on("error", (err) => {
  // Idle client errors (e.g. connection reset) must not crash the process.
  console.error("[db] unexpected pool error", err);
});

export type QueryParams = ReadonlyArray<unknown>;

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: QueryParams
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as unknown[]);
}

/**
 * Runs `fn` inside a single transaction using a dedicated client.
 * Commits on success, rolls back and rethrows on error. Always releases the client.
 */
export async function withTx<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      console.error("[db] rollback failed", rollbackErr);
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function checkHealth(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
