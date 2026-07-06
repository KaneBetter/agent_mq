// User session store: persists the logged-in user's `mq_session` cookie value
// alongside the agent config in ./.agent-mq/config.json (see config.ts). This is
// distinct from the per-agent Bearer token used by claim/heartbeat/complete —
// the session authenticates the human/operator for management calls
// (register/subscribe/spaces), the agent Bearer token authenticates the worker.
import { loadConfig, updateConfig, type AgentConfig } from "./config.js";

export interface UserSession {
  session_token: string;
  username: string;
}

/** Read the stored user session, if any. */
export async function loadSession(): Promise<UserSession | undefined> {
  const config = await loadConfig();
  return sessionFromConfig(config);
}

export function sessionFromConfig(config: AgentConfig): UserSession | undefined {
  if (config.session_token && config.username) {
    return { session_token: config.session_token, username: config.username };
  }
  return undefined;
}

/** Persist a new user session into the shared config file. */
export async function saveSession(session: UserSession): Promise<void> {
  await updateConfig({
    session_token: session.session_token,
    username: session.username,
  });
}

/** Clear the stored user session (used by `logout`), leaving agent credentials intact. */
export async function clearSession(): Promise<void> {
  await updateConfig({ session_token: undefined, username: undefined });
}
