// Config load/save for agent-mq.
// Precedence for server URL: --server flag > AGENTMQ_SERVER env > saved config > default.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_SERVER = "http://localhost:4000";
const CONFIG_DIR = path.join(process.cwd(), ".agent-mq");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

export interface AgentConfig {
  server: string;
  agent_id?: string;
  api_token?: string;
  name?: string;
  max_concurrency?: number;
}

/** Read the persisted config file, if any. Returns an empty shell on missing/corrupt file. */
export async function loadConfig(): Promise<AgentConfig> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return { server: DEFAULT_SERVER, ...(parsed as Partial<AgentConfig>) };
    }
    return { server: DEFAULT_SERVER };
  } catch {
    return { server: DEFAULT_SERVER };
  }
}

/** Persist config to ./.agent-mq/config.json, creating the directory if needed. */
export async function saveConfig(config: AgentConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
}

/** Merge a partial update into the saved config and persist the result. */
export async function updateConfig(
  patch: Partial<AgentConfig>,
): Promise<AgentConfig> {
  const current = await loadConfig();
  const next: AgentConfig = { ...current, ...patch };
  await saveConfig(next);
  return next;
}

/**
 * Resolve the effective server URL following precedence:
 * --server flag > AGENTMQ_SERVER env > saved config > default.
 */
export function resolveServer(
  flagValue: string | undefined,
  savedServer: string | undefined,
): string {
  if (flagValue && flagValue.trim() !== "") return flagValue.trim();
  const envValue = process.env.AGENTMQ_SERVER;
  if (envValue && envValue.trim() !== "") return envValue.trim();
  if (savedServer && savedServer.trim() !== "") return savedServer.trim();
  return DEFAULT_SERVER;
}

export { DEFAULT_SERVER, CONFIG_PATH };
