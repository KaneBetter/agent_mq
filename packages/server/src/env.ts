// Environment configuration. dotenv is loaded here but must NEVER override
// an already-set env var (important under docker compose, which injects env directly).
import "dotenv/config";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : raw;
}

export interface Env {
  DATABASE_URL: string;
  SERVER_HOST: string;
  SERVER_PORT: number;
  DEFAULT_VISIBILITY_TIMEOUT: number;
  REAPER_INTERVAL_MS: number;
  BACKOFF_BASE_SEC: number;
  BACKOFF_CAP_SEC: number;
  DEFAULT_MAX_RETRIES: number;
  /** Heartbeat staleness threshold (ms) before an agent is flipped offline. */
  AGENT_STALE_MS: number;
}

export const env: Env = {
  DATABASE_URL: str(
    "DATABASE_URL",
    "postgres://agentmq:agentmq@localhost:5432/agentmq"
  ),
  SERVER_HOST: str("SERVER_HOST", "0.0.0.0"),
  SERVER_PORT: num("SERVER_PORT", 4000),
  DEFAULT_VISIBILITY_TIMEOUT: num("DEFAULT_VISIBILITY_TIMEOUT", 900),
  REAPER_INTERVAL_MS: num("REAPER_INTERVAL_MS", 5000),
  BACKOFF_BASE_SEC: num("BACKOFF_BASE_SEC", 2),
  BACKOFF_CAP_SEC: num("BACKOFF_CAP_SEC", 300),
  DEFAULT_MAX_RETRIES: num("DEFAULT_MAX_RETRIES", 3),
  AGENT_STALE_MS: num("AGENT_STALE_MS", 30_000),
};
