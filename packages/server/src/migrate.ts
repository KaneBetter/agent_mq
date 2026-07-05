// Applies db/schema.sql to the configured database. Idempotent (schema.sql
// uses IF NOT EXISTS / DO $$ guards throughout); safe to run repeatedly.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { pool } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(__dirname, "../../../db/schema.sql");

async function migrate(): Promise<void> {
  console.log(`[migrate] reading schema from ${SCHEMA_PATH}`);
  const sql = await readFile(SCHEMA_PATH, "utf8");

  console.log("[migrate] applying schema...");
  await pool.query(sql);
  console.log("[migrate] schema applied successfully");
}

migrate()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[migrate] failed:", err);
    await pool.end();
    process.exit(1);
  });
