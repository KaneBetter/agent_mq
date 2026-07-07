// Client-side recurring executor for `agent-mq schedule install|list`.
//
// The server (see BUILD-CONTRACT.md v4 delta) records agent polling schedules
// on register/subscribe purely for visibility in the dashboard — it never
// triggers anything itself. THIS module is the executor: it wires up a local
// launchd (macOS) or cron (Linux) job that periodically shells out to
// `agent-mq run --once`, so a claim actually happens on the interval the
// server thinks is being honored.
//
// Security: every input (label, project name, interval) is treated as
// untrusted. We never build a shell string by concatenating user input.
// launchd gets an argv array (no shell involved at all). cron technically
// requires a single command line, but the only variable part we place there
// is a validated, slug-safe label and an absolute, fixed set of paths/flags
// we generate ourselves — never raw user text is spliced into the line
// without first passing through `assertSafeToken`.
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ScheduleInstallOptions {
  intervalSec: number;
  project?: string;
  space?: string;
  // "run"     — claim work (`agent-mq run --once`); used for space + topic polls.
  // "updates" — read the site's news timeline (`agent-mq updates`); the connect-step poll.
  mode?: "run" | "updates";
  label?: string;
  dryRun: boolean;
  server?: string;
}

export interface ScheduleInstallResult {
  platform: "darwin" | "linux" | "unsupported";
  label: string;
  targetPath: string;
  content: string;
  command: string[];
  written: boolean;
  undoHint: string;
}

const LAUNCH_AGENTS_DIR = path.join(homedir(), "Library", "LaunchAgents");
const PLIST_PREFIX = "mq.agent.";

/** Reject anything that isn't a conservative slug: letters, digits, dash, underscore, dot. */
function assertSafeToken(value: string, fieldName: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(
      `${fieldName} contains unsafe characters (only letters, digits, '.', '_', '-' allowed): ${JSON.stringify(
        value,
      )}`,
    );
  }
  return value;
}

/** Derive a default label: topic poll → project-<name>, space poll → space-<name>, else site-update. */
export function deriveLabel(
  project: string | undefined,
  space: string | undefined,
  explicit: string | undefined,
): string {
  if (explicit) return assertSafeToken(explicit, "--label");
  if (project) return assertSafeToken(`project-${project}`, "derived label");
  if (space) return assertSafeToken(`space-${space}`, "derived label");
  return "site-update";
}

/**
 * Resolve the repo-relative absolute paths needed to invoke `agent-mq run --once`
 * from anywhere (cron/launchd run with a minimal environment and an unrelated
 * cwd, so relative paths and "pnpm --filter" workspace resolution are not
 * reliable). We instead resolve:
 *   - the absolute path to this package's local tsx binary
 *     (packages/agent/node_modules/.bin/tsx)
 *   - the absolute path to cli.ts (packages/agent/src/cli.ts)
 * and invoke `tsx cli.ts run --once [...]` directly. This assumes the repo
 * checkout (and its `pnpm install`ed node_modules) stays in place at the path
 * captured at install time — documented in the printed output and ONBOARDING.md.
 */
export function resolveCliCommand(subcommand: string[], extraArgs: string[]): string[] {
  const thisFile = fileURLToPath(import.meta.url);
  const agentSrcDir = path.dirname(thisFile); // .../packages/agent/src
  const agentPkgDir = path.dirname(agentSrcDir); // .../packages/agent
  const cliPath = path.join(agentSrcDir, "cli.ts");
  const tsxBin = path.join(
    agentPkgDir,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsx.cmd" : "tsx",
  );
  return [tsxBin, cliPath, ...subcommand, ...extraArgs];
}

/** The CLI subcommand the installed job runs: read the news feed, or claim work. */
function subcommandFor(options: ScheduleInstallOptions): string[] {
  return options.mode === "updates" ? ["updates"] : ["run", "--once"];
}

function resolveScheduledCommand(options: ScheduleInstallOptions): string[] {
  return resolveCliCommand(subcommandFor(options), buildRunArgs(options));
}

function buildRunArgs(options: ScheduleInstallOptions): string[] {
  const args: string[] = [];
  if (options.server) args.push("--server", options.server);
  return args;
}

// ── macOS (launchd) ─────────────────────────────────────────────────────────

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildPlist(label: string, command: string[], intervalSec: number): string {
  const programArguments = command
    .map((arg) => `        <string>${escapeXml(arg)}</string>`)
    .join("\n");
  const logDir = path.join(homedir(), "Library", "Logs", "agentmq");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(PLIST_PREFIX + label)}</string>
    <key>ProgramArguments</key>
    <array>
${programArguments}
    </array>
    <key>StartInterval</key>
    <integer>${Math.max(1, Math.round(intervalSec))}</integer>
    <key>RunAtLoad</key>
    <false/>
    <key>StandardOutPath</key>
    <string>${escapeXml(path.join(logDir, `${label}.out.log`))}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(path.join(logDir, `${label}.err.log`))}</string>
</dict>
</plist>
`;
}

async function installDarwin(
  options: ScheduleInstallOptions,
): Promise<ScheduleInstallResult> {
  const label = deriveLabel(options.project, options.space, options.label);
  const command = resolveScheduledCommand(options);
  const content = buildPlist(label, command, options.intervalSec);
  const targetPath = path.join(LAUNCH_AGENTS_DIR, `${PLIST_PREFIX}${label}.plist`);
  const undoHint = `launchctl unload -w ${targetPath} && rm ${targetPath}`;

  if (options.dryRun) {
    return {
      platform: "darwin",
      label,
      targetPath,
      content,
      command,
      written: false,
      undoHint,
    };
  }

  await mkdir(LAUNCH_AGENTS_DIR, { recursive: true });
  await mkdir(path.join(homedir(), "Library", "Logs", "agentmq"), { recursive: true });
  await writeFile(targetPath, content, "utf8");

  // Unload any previous instance of this label first so re-installing is idempotent;
  // ignore failure (it simply means nothing was loaded yet).
  try {
    execFileSync("launchctl", ["unload", "-w", targetPath], { stdio: "ignore" });
  } catch {
    // not previously loaded — fine.
  }
  execFileSync("launchctl", ["load", "-w", targetPath], { stdio: "inherit" });

  return {
    platform: "darwin",
    label,
    targetPath,
    content,
    command,
    written: true,
    undoHint,
  };
}

// ── Linux (cron) ─────────────────────────────────────────────────────────────

const CRON_MARKER_PREFIX = "# agentmq:";

function intervalToCronSchedule(intervalSec: number): { expr: string; note?: string } {
  // cron's minimum granularity is 1 minute. Anything under 60s is rounded up
  // and documented; anything that isn't a clean divisor of 60 minutes falls
  // back to "every minute" with a note, since cron cannot express arbitrary
  // second-level or non-divisor-minute intervals.
  const minutes = Math.max(1, Math.round(intervalSec / 60));
  if (intervalSec < 60) {
    return {
      expr: "* * * * *",
      note: `cron's minimum granularity is 1 minute; --interval ${intervalSec}s was rounded up to every 1 minute.`,
    };
  }
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    if (hours < 24) return { expr: `0 */${hours} * * *` };
    if (hours % 24 === 0) return { expr: `0 0 */${hours / 24} * *` };
  }
  // A `*/N` step in the minute field is only valid for N in 1..59, so only use it
  // when the interval is under an hour. Anything larger that isn't a whole number
  // of hours is rounded to the nearest hour/day (with an honest note) — never
  // emitting an out-of-range `*/N` that cron would reject or misinterpret.
  if (minutes < 60) {
    if (60 % minutes === 0) return { expr: `*/${minutes} * * * *` };
    return {
      expr: `*/${minutes} * * * *`,
      note: `--interval ${intervalSec}s (~${minutes}m) is not a clean divisor of 60 minutes; cron resets the step each hour, so cadence may drift.`,
    };
  }
  const hours = Math.max(1, Math.round(minutes / 60));
  if (hours < 24) {
    return {
      expr: `0 */${hours} * * *`,
      note: `--interval ${intervalSec}s is not a whole number of hours; rounded to every ${hours}h (cron cannot express ${minutes}m in the minute field).`,
    };
  }
  const days = Math.max(1, Math.round(hours / 24));
  return {
    expr: `0 0 */${days} * *`,
    note: `--interval ${intervalSec}s rounded to every ${days}d (cron cannot express ${minutes}m exactly).`,
  };
}

function buildCronLine(label: string, schedule: string, command: string[]): string {
  // Quote each argv element for POSIX sh; command[] entries are either paths
  // we generated ourselves or a validated slug/URL, never raw free-text.
  const quoted = command.map((part) => `'${part.replace(/'/g, `'\\''`)}'`).join(" ");
  return `${schedule} ${quoted} >> ${quoteShellPath(cronLogPath(label))} 2>&1 ${CRON_MARKER_PREFIX}${label}`;
}

function cronLogPath(label: string): string {
  return path.join(homedir(), ".agent-mq", "logs", `${label}.log`);
}

function quoteShellPath(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

function readCurrentCrontab(): string {
  try {
    return execFileSync("crontab", ["-l"], { encoding: "utf8" });
  } catch {
    // No crontab installed yet for this user.
    return "";
  }
}

async function installLinux(options: ScheduleInstallOptions): Promise<ScheduleInstallResult> {
  const label = deriveLabel(options.project, options.space, options.label);
  const command = resolveScheduledCommand(options);
  const { expr, note } = intervalToCronSchedule(options.intervalSec);
  const line = buildCronLine(label, expr, command);
  const targetPath = "crontab (current user)";
  const undoHint = `crontab -l | grep -vF '${CRON_MARKER_PREFIX}${label}' | crontab -   # or: crontab -e`;

  if (options.dryRun) {
    return {
      platform: "linux",
      label,
      targetPath,
      content: line + (note ? `\n# NOTE: ${note}` : ""),
      command,
      written: false,
      undoHint,
    };
  }

  await mkdir(path.join(homedir(), ".agent-mq", "logs"), { recursive: true });

  const existing = readCurrentCrontab();
  // Match the label marker LITERALLY (endsWith), not as a regex — a label may
  // contain '.', which as a regex wildcard would drop an unrelated poll's line.
  const markerSuffix = `${CRON_MARKER_PREFIX}${label}`;
  const filtered = existing
    .split("\n")
    .filter((l) => l.trim().length > 0 && !l.trimEnd().endsWith(markerSuffix))
    .join("\n");
  const next = (filtered.length > 0 ? filtered + "\n" : "") + line + "\n";

  execFileSync("crontab", ["-"], { input: next, encoding: "utf8" });

  return {
    platform: "linux",
    label,
    targetPath,
    content: line + (note ? `\n# NOTE: ${note}` : ""),
    command,
    written: true,
    undoHint,
  };
}

/** Install (or dry-run print) a recurring `agent-mq run --once` on this machine. */
export async function installSchedule(
  options: ScheduleInstallOptions,
): Promise<ScheduleInstallResult> {
  if (options.intervalSec <= 0 || !Number.isFinite(options.intervalSec)) {
    throw new Error("--interval must be a positive number of seconds");
  }
  if (options.project) assertSafeToken(options.project, "--project");
  if (options.space) assertSafeToken(options.space, "--space");
  if (options.label) assertSafeToken(options.label, "--label");

  const plat = platform();
  if (plat === "darwin") return installDarwin(options);
  if (plat === "linux") return installLinux(options);

  throw new Error(
    `agent-mq schedule install is only implemented for macOS (launchd) and Linux (cron); this host reports platform=${plat}`,
  );
}

// ── list ──────────────────────────────────────────────────────────────────

export interface InstalledScheduleEntry {
  label: string;
  source: "launchd" | "cron";
  detail: string;
}

async function listDarwin(): Promise<InstalledScheduleEntry[]> {
  let names: string[] = [];
  try {
    const raw = await readdirSafe(LAUNCH_AGENTS_DIR);
    names = raw.filter((f) => f.startsWith(PLIST_PREFIX) && f.endsWith(".plist"));
  } catch {
    names = [];
  }

  const entries: InstalledScheduleEntry[] = [];
  for (const file of names) {
    const label = file.slice(PLIST_PREFIX.length, -".plist".length);
    const fullPath = path.join(LAUNCH_AGENTS_DIR, file);
    let loaded = "unknown";
    try {
      const list = execFileSync("launchctl", ["list"], { encoding: "utf8" });
      loaded = list.includes(PLIST_PREFIX + label) ? "loaded" : "not loaded";
    } catch {
      loaded = "unknown (launchctl list failed)";
    }
    entries.push({ label, source: "launchd", detail: `${fullPath} (${loaded})` });
  }
  return entries;
}

async function readdirSafe(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  return readdir(dir);
}

async function listLinux(): Promise<InstalledScheduleEntry[]> {
  const raw = readCurrentCrontab();
  const entries: InstalledScheduleEntry[] = [];
  for (const line of raw.split("\n")) {
    const match = line.match(/# agentmq:(\S+)\s*$/);
    if (!match) continue;
    entries.push({ label: match[1] ?? "?", source: "cron", detail: line.trim() });
  }
  return entries;
}

export async function listInstalledSchedules(): Promise<InstalledScheduleEntry[]> {
  const plat = platform();
  if (plat === "darwin") return listDarwin();
  if (plat === "linux") return listLinux();
  return [];
}

/** Read the current agent-mq schedule config file to show the assumption baked into the executor. */
export async function describeAssumption(): Promise<string> {
  const thisFile = fileURLToPath(import.meta.url);
  const agentPkgDir = path.dirname(path.dirname(thisFile));
  return (
    `Assumes this repo checkout stays at ${path.dirname(agentPkgDir)} and ` +
    `\`pnpm install\` has been run (so ${path.join(agentPkgDir, "node_modules", ".bin", "tsx")} exists). ` +
    `If you move or delete the checkout, re-run \`agent-mq schedule install\`.`
  );
}
