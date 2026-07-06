#!/usr/bin/env tsx
// agent-mq — the agent-mq worker CLI. See BUILD-CONTRACT.md for the full spec.
import type {
  ClaimedTask,
  CompleteTaskRequest,
  RegisterAgentRequest,
  ResultStatus,
  SpaceSummary,
} from "@agentmq/shared";
import { ApiClient, ApiError } from "./api.js";
import { getBool, getList, getNumber, getString, parseArgs } from "./args.js";
import { loadConfig, resolveServer, saveConfig, updateConfig } from "./config.js";
import { color, fail, info, ok, warn } from "./colors.js";
import { PromptSession } from "./prompt.js";
import { clearSession, saveSession, sessionFromConfig } from "./session.js";
import { describeAssumption, installSchedule, listInstalledSchedules } from "./scheduleInstall.js";
import { runWorker } from "./worker.js";

const HELP = `${color.bold("agent-mq")} — agent-mq worker CLI

${color.bold("USAGE")}
  agent-mq <command> [flags]

${color.bold("COMMANDS")}
  login                  Log in as a user, save the session (cookie) locally
  whoami                 Print the logged-in user, or "not logged in"
  logout                 Clear the saved session (best-effort server logout)
  register               Register this machine as an agent, save credentials
  subscribe              Subscribe the registered agent to a project/group
  claim                  Claim a single task and print it (no execution)
  heartbeat              Send an agent-level heartbeat
  complete <task_id>     Report a task result
  fail <task_id>         Report a task failure (shortcut for complete --status failure)
  run                    Worker loop: heartbeat -> claim -> dispatch -> complete
  schedule install       Install a local recurring "run --once" (launchd/cron)
  schedule list          List installed mq launchd/cron entries on this machine

${color.bold("GLOBAL FLAGS")}
  --server <url>        Server base URL (else AGENTMQ_SERVER env, else saved config,
                         else http://localhost:4000)

${color.bold("login")}
  --server <url>         Optional. Server to log into (see GLOBAL FLAGS precedence).
  --username <u>         Optional. Prompted on stdin if omitted.
  --password <p>         Optional. Prompted on stdin (hidden if TTY) if omitted.

${color.bold("whoami")}
  (no flags — prints the current session's user, or "not logged in")

${color.bold("logout")}
  (no flags — clears the saved session)

${color.bold("register")}
  --name <name>          Required. Agent display name.
  --space <slug|id>      Required. Space to register this consumer into
                         (matched by id, else by name/slug via GET /api/spaces).
  --owner <owner>        Optional owner/human label.
  --caps <a,b,c>         Comma-separated capability tags (e.g. shell,gpu).
  --max-concurrency <k>  Max in-flight tasks (default server-side default).
  --project <id|name>    Optional. Auto-subscribe to this project on register.
  --server <url>
  Requires a saved login session (run \`agent-mq login\` first).

${color.bold("subscribe")}
  --project <id|name>    Required. Project id or name (name is resolved via GET /api/projects).
  --group <name>         Optional group name (default project group if omitted).

${color.bold("claim")}
  (no flags — uses saved agent credentials)

${color.bold("heartbeat")}
  (no flags — agent-level heartbeat only)

${color.bold("complete <task_id>")}
  --status <success|failure>  Required.
  --result <json>              Optional JSON string result payload.
  --tokens <in,out>             Optional "input,output" token counts.
  --model <name>                Optional model label for metrics.
  --error <msg>                 Optional error message (status=failure).

${color.bold("fail <task_id>")}
  --error <msg>          Optional error message.

${color.bold("run")}
  --once                 Single claim+run then exit (cron/launchd model).
  --interval <sec>       Base idle backoff interval in seconds (default 2).
  --concurrency <k>      Max concurrent tasks (default = agent's max_concurrency).
  --allow-shell          Enable the shell.command handler (disabled by default).

${color.bold("schedule install")}
  --interval <sec>       Required. Seconds between runs of \`agent-mq run --once\`.
  --project <name>       Optional. Poll this project (label defaults to project-<name>).
                          Omit for the daily site-wide poll (label defaults to site-update).
  --label <l>            Optional. Override the derived label.
  --dry-run              Print what would be written; write nothing.
  --server <url>         Baked into the installed command's --server flag.

${color.bold("schedule list")}
  (no flags — lists installed launchd (macOS) / cron (Linux) mq entries)

${color.bold("EXAMPLES")}
  agent-mq login --server http://localhost:4000
  agent-mq whoami
  agent-mq register --name mac-01 --space my-team --caps shell,gpu --owner alice --project research
  agent-mq subscribe --project research
  agent-mq run
  agent-mq run --once --allow-shell
  agent-mq schedule install --interval 86400
  agent-mq schedule install --interval 60 --project research
  agent-mq schedule list
  agent-mq logout
`;

function printHelp(): void {
  process.stdout.write(HELP);
}

function requireAgentCredentials(
  config: Awaited<ReturnType<typeof loadConfig>>,
): { agentId: string; apiToken: string } {
  if (!config.agent_id || !config.api_token) {
    fail("no registered agent found; run `agent-mq register --name <name>` first");
    process.exit(1);
  }
  return { agentId: config.agent_id, apiToken: config.api_token };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Look up the saved session, exiting with the mandated error if there isn't one. */
function requireSessionOrExit(
  config: Awaited<ReturnType<typeof loadConfig>>,
): { session_token: string; username: string } {
  const session = sessionFromConfig(config);
  if (!session) {
    fail("run 'agent-mq login' first");
    process.exit(1);
  }
  return session;
}

/** Resolve a `--space <slug|id>` argument to a space id: direct UUID match, else name/slug via GET /api/spaces. */
async function resolveSpaceId(api: ApiClient, spaceIdOrSlug: string): Promise<string> {
  if (UUID_PATTERN.test(spaceIdOrSlug)) return spaceIdOrSlug;

  const spaces = await api.spaces();
  const match = spaces.find(
    (s: SpaceSummary) => s.id === spaceIdOrSlug || s.slug === spaceIdOrSlug || s.name === spaceIdOrSlug,
  );
  if (!match) {
    throw new Error(
      `no space matching "${spaceIdOrSlug}" found (checked GET /api/spaces by id/slug/name)`,
    );
  }
  return match.id;
}

async function cmdLogin(flags: Map<string, string | true>): Promise<void> {
  const config = await loadConfig();
  const server = resolveServer(getString(flags, "server"), config.server);
  const api = new ApiClient({ server });

  let username = getString(flags, "username");
  let password = getString(flags, "password");
  if (!username || !password) {
    const prompts = new PromptSession();
    try {
      if (!username) username = await prompts.promptLine("username: ");
      if (!password) password = await prompts.promptPassword("password: ");
    } finally {
      prompts.close();
    }
  }
  if (!username || !password) {
    fail("username and password are required");
    process.exit(1);
  }

  info(`logging in to ${server} as "${username}"...`);
  const { auth, sessionToken } = await api.login({ username, password });
  await saveSession({ session_token: sessionToken, username: auth.user.username });
  await updateConfig({ server });
  ok(`logged in as ${color.bold(auth.user.username)}`);
}

async function cmdWhoami(flags: Map<string, string | true>): Promise<void> {
  const config = await loadConfig();
  const session = sessionFromConfig(config);
  if (!session) {
    info("not logged in");
    return;
  }
  const server = resolveServer(getString(flags, "server"), config.server);
  const api = new ApiClient({ server, sessionToken: session.session_token });

  try {
    const res = await api.authMe();
    ok(`logged in as ${color.bold(res.user.username)} (${server})`);
  } catch (err: unknown) {
    if (err instanceof ApiError && err.status === 401) {
      info("not logged in");
      return;
    }
    throw err;
  }
}

async function cmdLogout(flags: Map<string, string | true>): Promise<void> {
  const config = await loadConfig();
  const session = sessionFromConfig(config);
  if (!session) {
    info("not logged in");
    return;
  }
  const server = resolveServer(getString(flags, "server"), config.server);
  const api = new ApiClient({ server, sessionToken: session.session_token });

  try {
    await api.authLogout();
  } catch (err: unknown) {
    // Best-effort: clear the local session regardless of server-side outcome.
    const message = err instanceof Error ? err.message : String(err);
    warn(`server logout failed (clearing local session anyway): ${message}`);
  }
  await clearSession();
  ok("logged out");
}

async function cmdRegister(flags: Map<string, string | true>): Promise<void> {
  const name = getString(flags, "name");
  if (!name) {
    fail("--name is required");
    process.exit(1);
  }

  // Check the session before --space: an unauthenticated caller should see
  // "run 'agent-mq login' first" regardless of which other flags are missing.
  const config = await loadConfig();
  const session = requireSessionOrExit(config);

  const spaceArg = getString(flags, "space");
  if (!spaceArg) {
    fail("--space <slug|id> is required");
    process.exit(1);
  }

  const server = resolveServer(getString(flags, "server"), config.server);
  const api = new ApiClient({ server, sessionToken: session.session_token });

  const spaceId = await resolveSpaceId(api, spaceArg);

  const projectArg = getString(flags, "project");
  const projectId = projectArg ? await resolveProjectId(api, projectArg) : undefined;

  const req: RegisterAgentRequest = {
    name,
    owner: getString(flags, "owner"),
    capabilities: getList(flags, "caps"),
    max_concurrency: getNumber(flags, "max-concurrency"),
    space_id: spaceId,
    project_id: projectId,
  };

  info(`registering "${name}" with ${server} (space=${spaceId})...`);
  const res = await api.register(req);
  await saveConfig({
    ...config,
    server,
    agent_id: res.agent_id,
    api_token: res.api_token,
    name,
    max_concurrency: res.agent.max_concurrency,
  });
  ok(`registered agent ${color.bold(res.agent_id)} (max_concurrency=${res.agent.max_concurrency})`);
  info(`credentials saved to ./.agent-mq/config.json`);
}

async function resolveProjectId(api: ApiClient, projectIdOrName: string): Promise<string> {
  // If it already looks like a UUID, use it directly rather than resolving by name.
  if (UUID_PATTERN.test(projectIdOrName)) return projectIdOrName;

  const projects = await api.listProjects();
  const match = projects.find((p) => p.name === projectIdOrName);
  if (!match) {
    throw new Error(
      `no project named "${projectIdOrName}" found (checked GET /api/projects); pass a project id instead`,
    );
  }
  return match.id;
}

async function cmdSubscribe(flags: Map<string, string | true>): Promise<void> {
  const config = await loadConfig();
  const { apiToken } = requireAgentCredentials(config);
  const session = requireSessionOrExit(config);
  const server = resolveServer(getString(flags, "server"), config.server);
  const api = new ApiClient({ server, apiToken, sessionToken: session.session_token });

  const projectArg = getString(flags, "project");
  if (!projectArg) {
    fail("--project <id|name> is required");
    process.exit(1);
  }
  const groupName = getString(flags, "group");

  const projectId = await resolveProjectId(api, projectArg);
  const sub = await api.subscribe({ project_id: projectId, group_name: groupName });
  ok(`subscribed to project ${color.bold(projectId)} group ${color.bold(sub.group_id)}`);
}

async function cmdHeartbeat(flags: Map<string, string | true>): Promise<void> {
  const config = await loadConfig();
  const { apiToken } = requireAgentCredentials(config);
  const server = resolveServer(getString(flags, "server"), config.server);
  const api = new ApiClient({ server, apiToken });

  const res = await api.agentHeartbeat();
  ok(`heartbeat ok, status=${res.status}`);
}

async function cmdClaim(flags: Map<string, string | true>): Promise<ClaimedTask | null> {
  const config = await loadConfig();
  const { apiToken } = requireAgentCredentials(config);
  const server = resolveServer(getString(flags, "server"), config.server);
  const api = new ApiClient({ server, apiToken });

  const { task } = await api.claim();
  if (!task) {
    info("no task available");
    return null;
  }
  ok(`claimed task ${color.bold(task.id)} type=${task.type} project=${task.project_name}`);
  process.stdout.write(JSON.stringify(task, null, 2) + "\n");
  return task;
}

function parseTokens(raw: string | undefined): { input?: number; output?: number } | undefined {
  if (!raw) return undefined;
  const parts = raw.split(",").map((s) => Number(s.trim()));
  const [input, output] = parts;
  return {
    input: Number.isFinite(input) ? input : undefined,
    output: Number.isFinite(output) ? output : undefined,
  };
}

function parseResultJson(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    warn("--result did not parse to a JSON object; wrapping as { value: ... }");
    return { value: parsed };
  } catch {
    warn("--result was not valid JSON; storing as raw string under { value }");
    return { value: raw };
  }
}

async function cmdComplete(
  taskId: string,
  flags: Map<string, string | true>,
  forcedStatus?: ResultStatus,
): Promise<void> {
  const config = await loadConfig();
  const { apiToken } = requireAgentCredentials(config);
  const server = resolveServer(getString(flags, "server"), config.server);
  const api = new ApiClient({ server, apiToken });

  const statusFlag = getString(flags, "status");
  const status: ResultStatus = forcedStatus ?? (statusFlag === "failure" ? "failure" : "success");
  if (!forcedStatus && statusFlag !== "success" && statusFlag !== "failure") {
    fail("--status must be 'success' or 'failure'");
    process.exit(1);
  }

  const tokens = parseTokens(getString(flags, "tokens"));
  const model = getString(flags, "model");
  const error = getString(flags, "error");
  const result = parseResultJson(getString(flags, "result"));

  const req: CompleteTaskRequest = {
    status,
    result,
    error,
    metrics: tokens || model ? { model, tokens: { ...tokens, total: (tokens?.input ?? 0) + (tokens?.output ?? 0) } } : undefined,
  };

  const res = await api.complete(taskId, req);
  ok(`task ${taskId} -> ${res.task_status}${res.requeued ? " (requeued)" : ""}`);
}

async function cmdRun(flags: Map<string, string | true>): Promise<void> {
  const config = await loadConfig();
  const { agentId, apiToken } = requireAgentCredentials(config);
  const server = resolveServer(getString(flags, "server"), config.server);
  const api = new ApiClient({ server, apiToken });

  const once = getBool(flags, "once");
  const intervalSec = getNumber(flags, "interval") ?? 2;
  const concurrency = getNumber(flags, "concurrency") ?? config.max_concurrency ?? 1;
  const allowShell = getBool(flags, "allow-shell");

  if (allowShell) {
    warn("--allow-shell is enabled: shell.command will execute untrusted payload.cmd on this machine");
  }

  await runWorker(api, agentId, { once, intervalSec, concurrency, allowShell });
}

async function cmdScheduleInstall(flags: Map<string, string | true>): Promise<void> {
  const intervalSec = getNumber(flags, "interval");
  if (intervalSec === undefined) {
    fail("--interval <sec> is required");
    process.exit(1);
  }
  const project = getString(flags, "project");
  const label = getString(flags, "label");
  const dryRun = getBool(flags, "dry-run");
  const config = await loadConfig();
  const server = resolveServer(getString(flags, "server"), config.server);

  const result = await installSchedule({
    intervalSec,
    project,
    label,
    dryRun,
    server,
  });

  info(`platform=${result.platform} label=${color.bold(result.label)}`);
  info(`command: ${result.command.join(" ")}`);
  info(`target: ${result.targetPath}`);
  process.stdout.write(`--- content (${result.targetPath}) ---\n`);
  process.stdout.write(result.content + "\n");

  if (dryRun) {
    warn("--dry-run: nothing was written");
  } else {
    ok(`installed (${result.written ? "written" : "unchanged"})`);
  }
  info(`undo: ${result.undoHint}`);
  info(await describeAssumption());
}

async function cmdScheduleList(): Promise<void> {
  const entries = await listInstalledSchedules();
  if (entries.length === 0) {
    info("no mq launchd/cron entries found on this machine");
    return;
  }
  for (const entry of entries) {
    ok(`[${entry.source}] ${color.bold(entry.label)} — ${entry.detail}`);
  }
}

async function cmdSchedule(subcommand: string | undefined, flags: Map<string, string | true>): Promise<void> {
  switch (subcommand) {
    case "install":
      await cmdScheduleInstall(flags);
      break;
    case "list":
      await cmdScheduleList();
      break;
    default:
      fail(`usage: agent-mq schedule install --interval <sec> [--project <name>] [--label <l>] [--dry-run]`);
      fail(`   or: agent-mq schedule list`);
      process.exit(1);
  }
}

async function main(): Promise<void> {
  // pnpm/npm forward a literal "--" separator when script chains are nested
  // (e.g. `pnpm agent-mq -- --help` -> `pnpm --filter ... start -- -- --help`,
  // two levels of wrapping when invoked via the root `agent-mq` script, which
  // itself ends in `start --`). Strip ALL leading bare "--" tokens so direct,
  // single-wrapped, and double-wrapped invocations all work.
  const rawArgv = process.argv.slice(2);
  let stripIdx = 0;
  while (rawArgv[stripIdx] === "--") stripIdx++;
  const argv = rawArgv.slice(stripIdx);
  const command = argv[0];
  const rest = argv.slice(1);
  const { flags, positionals } = parseArgs(rest);

  if (!command || command === "--help" || command === "-h" || command === "help") {
    printHelp();
    return;
  }

  try {
    switch (command) {
      case "login":
        await cmdLogin(flags);
        break;
      case "whoami":
        await cmdWhoami(flags);
        break;
      case "logout":
        await cmdLogout(flags);
        break;
      case "register":
        await cmdRegister(flags);
        break;
      case "subscribe":
        await cmdSubscribe(flags);
        break;
      case "claim":
        await cmdClaim(flags);
        break;
      case "heartbeat":
        await cmdHeartbeat(flags);
        break;
      case "complete": {
        const taskId = positionals[0];
        if (!taskId) {
          fail("usage: agent-mq complete <task_id> --status success|failure");
          process.exit(1);
        }
        await cmdComplete(taskId, flags);
        break;
      }
      case "fail": {
        const taskId = positionals[0];
        if (!taskId) {
          fail("usage: agent-mq fail <task_id> [--error msg]");
          process.exit(1);
        }
        await cmdComplete(taskId, flags, "failure");
        break;
      }
      case "run":
        await cmdRun(flags);
        break;
      case "schedule":
        await cmdSchedule(positionals[0], flags);
        break;
      default:
        fail(`unknown command "${command}"`);
        printHelp();
        process.exit(1);
    }
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      fail(`API error (${err.status}): ${err.message}`);
    } else {
      const message = err instanceof Error ? err.message : String(err);
      fail(message);
    }
    process.exit(1);
  }
}

main();
