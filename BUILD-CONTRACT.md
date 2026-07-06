# agent-mq — BUILD CONTRACT (single source of truth)

A distributed agent management system: a **Postgres-backed pull task queue**.
Concept map: **Project = Topic, Task = Message, Agent = Consumer, Group = Consumer Group**.
Routing = **FIFO + capability hard-filter + per-agent concurrency limit**. No scoring, no reputation.
Reported metrics are **display-only** and never affect routing.

This file is authoritative. If code and this file disagree, this file wins. Do not invent
extra endpoints, tables, or fields beyond what is here unless clearly implied.

## Repo layout (pnpm workspace)

```
agent_mq/
  package.json            root scripts (already written)
  pnpm-workspace.yaml     packages/*
  docker-compose.yml      postgres:16-alpine, db published on :5432
  .env.example            copy to .env
  db/schema.sql           full schema (already written — DO NOT edit)
  packages/
    shared/               @agentmq/shared — types (already written — DO NOT edit)
    server/               @agentmq/server — Fastify + pg  (YOU MAY BUILD)
    web/                  @agentmq/web — React + Vite dispatch console (YOU MAY BUILD)
    agent/                @agentmq/agent — agentctl CLI (YOU MAY BUILD)
```

Each builder owns ONE directory and must not touch another package's files.

## Shared facts

- Node 25, pnpm 10, TypeScript, ESM everywhere (`"type": "module"`).
- Import shared types from `@agentmq/shared` (workspace dep, points at raw `src/index.ts`).
- `DATABASE_URL=postgres://agentmq:agentmq@localhost:5432/agentmq` (host runs) — in Docker compose it is `...@db:5432/...`, injected via env. Read it from `process.env` (dotenv must NOT override an already-set env var).
- Server listens on `${SERVER_HOST:-0.0.0.0}:${SERVER_PORT:-4000}` (must bind `0.0.0.0` so it works inside a container). Web (Vite) on **5173**, points to `VITE_API_BASE` (default `http://localhost:4000`).
- **Runs via `docker compose up`** (primary) or `pnpm dev` (host). The root `Dockerfile` + `docker-compose.yml` already exist and are owned by the integrator — do NOT add per-package Dockerfiles. Compose invokes your package scripts `migrate`, `seed`, `dev`, and (agent) `start -- <cmd>`. Just make those scripts work from the package dir with env-provided `DATABASE_URL` / `AGENTMQ_SERVER`.
- Auth model (MVP, trusted LAN):
  - **Agent endpoints** require `Authorization: Bearer <api_token>` (the token minted at register). Server resolves the agent from the token.
  - **Management/UI endpoints** are open in dev (no auth) so the web console can call them directly. (Structure so an admin token could be added later; do not block on it.)
- All timestamps serialized as ISO strings. UUIDs as strings. `payload`/`output`/`machine_info` are JSON objects.
- Money: `cost_usd` numeric; return as `number`.

## Server package (@agentmq/server)

`packages/server/package.json` scripts (root scripts depend on these names):
- `dev` → `tsx watch src/index.ts`
- `start` → `tsx src/index.ts`
- `migrate` → `tsx src/migrate.ts` (reads `../../db/schema.sql`, applies it; idempotent)
- `seed` → `tsx src/seed.ts` (idempotent demo data: see Seed below)
- `demo` → `tsx src/demo.ts` (publishes a rolling stream of demo tasks so the live board moves)

Deps: `fastify`, `@fastify/cors`, `pg`, `dotenv`, `@agentmq/shared` (workspace:*). Dev: `tsx`, `typescript`, `@types/node`, `@types/pg`.

Structure suggestion: `src/index.ts` (bootstrap+routes), `src/db.ts` (pg Pool + query helper),
`src/claim.ts` (the claim transaction), `src/reaper.ts`, `src/events.ts` (EventEmitter + SSE),
`src/routes/*.ts`, `src/migrate.ts`, `src/seed.ts`, `src/demo.ts`.

Enable CORS for the web origin. Load `.env` via dotenv. On boot: connect pool, start reaper loop, start marking agents offline when `last_heartbeat_at` is stale (> 3× heartbeat interval, e.g. 30s).

### Endpoints (paths from `API_ROUTES` in @agentmq/shared)

Agent-facing (Bearer agent token unless noted):
- `POST /api/agents/register` (no auth) → body `RegisterAgentRequest` → `RegisterAgentResponse`.
  Mint `api_token` = crypto random. Insert agent (status `online`, `last_heartbeat_at=now()`). Emit `agent.registered` + `agent.online`.
- `POST /api/agents/heartbeat` → set `status='online'`, `last_heartbeat_at=now()` → `HeartbeatResponse`. Emit `agent.online` on transition.
- `POST /api/subscriptions` → `SubscribeRequest` → `Subscription`. If `group_id` omitted, use/create the project's `default` group (or `group_name`).
- `POST /api/claim` → `ClaimResponse`. **This is the core.** See Claim algorithm. Return `{task:null}` with HTTP **200** and also support **204** semantics (either is fine; web/agent treat `task:null` as "no task"). On success set task→CLAIMED, emit `task.claimed`.
- `POST /api/tasks/:id/heartbeat` → renew lease if this agent still holds it; else **409**. `TaskHeartbeatResponse`. On first heartbeat move CLAIMED→RUNNING and emit `task.running`.
- `POST /api/tasks/:id/complete` → `CompleteTaskRequest` → `CompleteTaskResponse`.
  Validate the agent holds a valid, unexpired lease (else 409). Insert `results` + `metrics`.
  - success → task `COMPLETED`, `completed_at=now()`, emit `task.completed`.
  - failure → if `retry_count < max_retries`: set `PENDING`, `retry_count++`, `visible_after=now()+backoff`, clear lease/assignment, emit `task.requeued`. Else `DEAD`, emit `task.dead`. Response `requeued` reflects which.
  - `wall_time_ms`: if agent omits it, server computes `now - claimed_at`.

Management/UI-facing (open in dev):
- `POST /api/projects` `CreateProjectRequest` → `Project` (also create default group). `GET /api/projects` → `ProjectSummary[]` (with backlog counts + eligible_agents + groups).
- `POST /api/groups` `CreateGroupRequest` → `Group`.
- `POST /api/task-types` `CreateTaskTypeRequest` → `TaskType`. `GET /api/task-types` → `TaskType[]`.
- `POST /api/tasks` `PublishTaskRequest` → `Task`. Honor `dedup_key` (on conflict return existing). Default `required_capabilities` from the task type if omitted. Emit `task.published`.
- `GET /api/tasks?status=&project_id=&type=&limit=` → `TaskDetail[]` (newest first; default limit 100).
- `GET /api/tasks/:id` → `TaskDetail`.
- `POST /api/tasks/:id/requeue` → move FAILED/DEAD/COMPLETED back to PENDING (reset lease/assignment, `visible_after=null`, keep retry_count or reset — reset is fine). Emit `task.requeued`.
- `POST /api/tasks/:id/cancel` → move a non-terminal task to DEAD (or a `CANCELED`-like terminal via DEAD). Emit `task.canceled`.
- `GET /api/agents` → `AgentSummary[]`. `GET /api/agents/:id` → `{ agent: AgentSummary, recent_tasks: TaskDetail[] }`.
- `GET /api/dashboard/overview` → `OverviewKPIs`.
- `GET /api/dashboard/costs` → `CostBreakdown` (group metrics by model/agent/project/day; `anomalies` = simple heuristic, e.g. any agent or day whose cost is > 3× the median bucket).
- `GET /api/events` → **SSE stream** of `LiveEvent` (`Content-Type: text/event-stream`, send `data: <json>\n\n`, heartbeat comment every ~15s, clean up on close).
- `GET /api/health` → `{ ok: true, db: true }`.

### Claim algorithm (implement exactly — this is the heart)

Rules: (1) capability hard-filter `task.required_capabilities <@ agent.capabilities`; (2) FIFO `ORDER BY priority DESC, created_at ASC`; (3) per-agent inflight `< max_concurrency`; (4) skip tasks whose `visible_after > now()`; (5) respect `target_group_id`.

Run in a single transaction:
1. Lock/read agent by token. Count inflight: `SELECT count(*) FROM tasks WHERE assigned_agent_id=$agent AND status IN ('CLAIMED','RUNNING')`. If `>= max_concurrency` → return `{task:null}`.
2. Atomic claim (an agent may span several subscriptions; pick the group from the matching subscription):

```sql
UPDATE tasks t SET
    status            = 'CLAIMED',
    assigned_agent_id = $1,
    group_id          = sub.group_id,
    claimed_at        = now(),
    lease_expires_at  = now() + ($2 || ' seconds')::interval
FROM (
    SELECT t.id, s.group_id
    FROM tasks t
    JOIN subscriptions s
      ON s.project_id = t.project_id AND s.agent_id = $1
    WHERE t.status = 'PENDING'
      AND (t.target_group_id IS NULL OR t.target_group_id = s.group_id)
      AND t.required_capabilities <@ $3::text[]        -- capability match
      AND (t.visible_after IS NULL OR t.visible_after <= now())
    ORDER BY t.priority DESC, t.created_at ASC          -- default priority equal => pure FIFO
    LIMIT 1
    FOR UPDATE OF t SKIP LOCKED
) sub
WHERE t.id = sub.id
RETURNING t.*;
```

`$1`=agent id, `$2`=lease seconds (`DEFAULT_VISIBILITY_TIMEOUT`), `$3`=agent capabilities array.
No row → `{task:null}`. Row → build `ClaimedTask` (add `project_name`, `lease_seconds`).

### Reaper
Every `REAPER_INTERVAL_MS`: within a Postgres advisory lock (`pg_try_advisory_lock`) so only one instance runs, find tasks in CLAIMED/RUNNING with `lease_expires_at < now()`, set back to PENDING, `retry_count++`, clear assignment/lease, set `visible_after=now()+backoff`; if `retry_count > max_retries` → DEAD. Emit `reaper.reclaimed` / `task.dead`. Also flip agents to `offline` when heartbeat is stale.

### Seed (idempotent)
Create projects + task types + default groups matching the design's task diversity. Suggested:
- Project **"research"** — types: `web.research`, `summarize.doc`.
- Project **"content"** — types: `draft.article`, `translate.text`.
- Project **"ops"** — types: `shell.command` (required_capabilities `["shell"]`), `image.generate` (required_capabilities `["gpu"]`).
Register a couple of demo agents is NOT needed (agents self-register), but you MAY create one example agent row named "seed-agent" is optional. Keep it minimal + idempotent (ON CONFLICT DO NOTHING by name).

### Demo (`src/demo.ts`)
Publishes N tasks (default ~30) across the seeded projects/types at a small interval so the board visibly fills, then exits. Use realistic-ish payloads (a URL to research, a paragraph to summarize, etc.).

## Agent package (@agentmq/agent) — `agentctl`

`packages/agent/package.json`:
- `bin`: `{ "agentctl": "./src/cli.ts" }` (run via tsx; also expose `start` script → `tsx src/cli.ts`).
- scripts: `start` → `tsx src/cli.ts`.
- Deps: `@agentmq/shared` (workspace:*). Dev: `tsx`, `typescript`, `@types/node`. Use built-in `fetch` (Node 25) — no axios.

State: persist `{ server, agent_id, api_token }` to `./.agentctl/config.json` (cwd) or `~/.agentctl/config.json`; allow `--server` / `AGENTMQ_SERVER` (default `http://localhost:4000`).

Commands (mirror the SKILL.md command surface):
- `agentctl register --name <n> [--owner o] [--caps a,b] [--max-concurrency k] [--server url]`
- `agentctl subscribe --project <id|name> [--group <name>]`
- `agentctl claim` — claim one, print it.
- `agentctl heartbeat` — agent-level heartbeat.
- `agentctl complete <task_id> --status success|failure [--result json] [--tokens in,out] [--model m]`
- `agentctl fail <task_id> [--error msg]`
- `agentctl run [--once] [--interval sec] [--concurrency k]` — the real worker loop:
  claim → dispatch to a **handler** by `task.type` → heartbeat while running → complete with metrics.
  `--once`: single claim+run then exit (the cron/launchd model). Otherwise loop with exponential backoff+jitter (2s→60s) when idle. Respect `--concurrency` (default = agent's max).
- Handler plugin architecture: a `handlers/` registry mapping `task.type → async (task, ctx) => { result, metrics }`.
  Ship built-ins: `echo` (returns payload), `sleep` (sleeps `payload.ms`, simulates a token burn), `web.research`/`summarize.doc`/`draft.article` as **mock LLM handlers** that fabricate plausible output + token counts (so the demo works with zero external keys), and a `shell.command` handler that is DISABLED by default (treat payload as untrusted; require `--allow-shell`).
  `ctx` gives `{ heartbeat(), server, agentId }`. Discipline: if a heartbeat returns 409 (lease lost), stop immediately and do not complete.

Print clean, colorized status lines. Treat `payload` as untrusted input.

## Web package (@agentmq/web) — dispatch console (the emphasized deliverable)

Built by the main thread; contract here so server/agent align on shapes. React 19 + Vite 6 + TypeScript.
Consumes the API + SSE. Five views: Overview (KPIs + live dispatch board + activity stream), Fleet, Projects, Queue, Publish. Dark "dispatch control room" aesthetic. Details owned by the web build.

## How to run (the whole thing)
```
cp .env.example .env
pnpm install
pnpm db:up && node scripts/wait-for-db.mjs && pnpm migrate && pnpm seed
pnpm dev                 # server:4000 + web:5173
pnpm demo                # (optional) stream demo tasks
# a worker on a "colleague machine":
pnpm agentctl register --name mac-01 --caps shell,gpu --owner alice
pnpm agentctl subscribe --project research
pnpm agentctl run
```

## Conventions
- Small focused files, explicit error handling, validate inputs at the boundary, immutable-ish updates.
- No secrets in code. No `any` where a shared type exists.
- Every endpoint returns JSON `{ error }` with a proper status on failure.

---

# v3 delta — tags, scheduling, register-in-UI, activity + calendar

Schema already migrated (`db/schema.sql`): `projects.tags text[]`, `tasks.tags text[]`,
`tasks.scheduled_for timestamptz`, and a new `activity` table. Shared types already updated
(`Project.tags`, `Task.tags`, `Task.scheduled_for`, `PublishTaskRequest.{tags,scheduled_for}`,
`CreateProjectRequest.tags`, `RegisterAgentRequest.{project_id,group_name}`, `ActivityRecord`,
`CalendarResponse`/`CalendarDay`/`ScheduledTaskLite`, new `API_ROUTES.activity`/`.calendar`,
new EventType `task.scheduled`). Do NOT re-edit shared or schema.

## Server changes (packages/server only)

1. **Row mappers**: include `tags` (default `[]`) and `scheduled_for` (ISO or null) on every Task/TaskDetail; include `tags` on Project/ProjectSummary. pg returns text[] as JS array already.

2. **Publish** (`POST /api/tasks`): accept `tags` (default `[]`) and `scheduled_for`.
   - If `scheduled_for` parses to a FUTURE time: set `tasks.scheduled_for` AND `tasks.visible_after = scheduled_for` (claim already skips visible_after), and emit `task.scheduled` (not `task.published`).
   - Else: normal publish, emit `task.published`. `scheduled_for` in the past/absent => immediate.
   - Persist tags to the row.

3. **Create project** (`POST /api/projects`): accept + store `tags`. `GET /api/projects` returns `tags`. Optional `?tag=` filter (`$1 = ANY(tags)`).

4. **Tasks list** (`GET /api/tasks`): add optional `?tag=` filter (`$n = ANY(t.tags)`). Include `tags` + `scheduled_for` in results.

5. **Register-to-project** (`POST /api/agents/register`): if body has `project_id`, after inserting the agent, upsert the group (`group_name` or `"default"`) for that project and insert a subscription (agent_id, project_id, group_id). Still returns `RegisterAgentResponse`. Emit `agent.registered`.

6. **Activity persistence**: every `emitEvent` must also insert into `activity`
   (type, project_id, task_id, agent_id, task_type, status, message, ts=event ts, meta='{}').
   Implement a sink in `events.ts` (e.g. `setActivitySink(fn)`) that `index.ts` wires to a
   fire-and-forget DB insert (catch + log; never block the request). Wire it after the pool exists.

7. **New endpoint** `GET /api/activity?project_id=&type=&limit=` → `ActivityRecord[]` newest first
   (limit default 100, cap 500). Join to fill `project_name` / `agent_name` when available.

8. **New endpoint** `GET /api/calendar?project_id=&from=YYYY-MM-DD&to=YYYY-MM-DD` → `CalendarResponse`.
   Default range = current month (1st..last day, server tz). For each day in [from,to]:
   - `activity_total` = count of activity rows that day (optionally filtered by project);
     `completed` = `task.completed`; `failed` = `task.failed` + `task.dead`;
     `published` = `task.published` + `task.scheduled`.
   - `scheduled` = tasks whose `scheduled_for` falls that day AND still `PENDING` (upcoming),
     mapped to `ScheduledTaskLite` (id, type, tags, project_id, project_name, status, scheduled_for).
   Bucket by `to_char(ts,'YYYY-MM-DD')` consistently; return every day in range (zero-filled).

9. **Seed**: give the 3 projects tags — research `["llm","research"]`, content `["llm","writing"]`,
   ops `["infra","gpu"]`. Keep idempotent.

10. **Demo** (`demo.ts`): add 1-3 random tags per task; ~20% of published tasks get a
    `scheduled_for` 2-40 min in the future (so the calendar's upcoming column has data).

Verify: typecheck; migrate is already applied; boot on port 4998, then curl:
publish a normal task + a scheduled task (`scheduled_for` future) + a tagged task;
`GET /api/activity` shows rows; `GET /api/calendar` returns day buckets incl. the scheduled task;
register with `project_id` auto-subscribes (claim then returns a task without a separate subscribe call).
Paste evidence. Kill the test server after.

---

# v4 delta — project detail, recurring schedules, agent onboarding

Schema already migrated: `tasks.schedule_id`, tables `schedules` and `agent_schedules`.
Shared types already added: `Recurrence`, `Schedule`, `CreateScheduleRequest`,
`UpdateScheduleRequest`, `ScheduleOccurrence`, `AgentSchedule`, `ProjectDetail`,
`OnboardingInfo`, `Task.schedule_id`, EventType `schedule.fired`, and
`API_ROUTES.{project,schedules,schedule,agentSchedules,onboarding}`. Do NOT re-edit shared/schema.

Design decisions (locked with the user):
- Onboarding = a copy-paste **prompt** for an LLM agent (not a shell installer).
- Agent polling schedules are **registered on the server** (visible) but **executed client-side** (cron).
- Recurring project tasks use **structured recurrence** (interval | weekly days+times), not raw cron.

## Server (packages/server only)

1. **Row mappers**: add `schedule_id` to Task mapping. Add mappers for Schedule + AgentSchedule.

2. **Scheduler ticker** — a new advisory-locked loop (like the reaper; every ~10s). Query
   `SELECT * FROM schedules WHERE enabled AND next_run_at <= now() FOR UPDATE SKIP LOCKED`.
   For each due schedule:
   - Build payload from `payload_template`; if `shift_hours` set, add
     `shift_start` = the fired slot ISO and `shift_end` = slot + shift_hours.
   - Insert a task (project_id, type, payload, tags, required_capabilities, target_group_id,
     `schedule_id`, status PENDING, claimable now). Emit `schedule.fired` + `task.published` (+activity).
   - Advance: `last_run_at` = fired slot, `next_run_at` = nextRun(recurrence, firedSlot), `runs_count++`.
   - Catch-up guard: never spawn more than one task per schedule per tick; if next_run is far behind,
     advance it to the next FUTURE occurrence (skip missed slots) without spawning a flood.

3. **nextRun(recurrence, after: Date): Date** helper (put in `src/scheduling.ts`):
   - `interval`: `next = after + interval_seconds`; while `next <= now` add interval (cap 10000 iters).
   - `weekly`: interpret `times` ("HH:MM") in `recurrence.timezone` (default `process.env.TZ || "UTC"`).
     Find the earliest instant strictly after `after` that lands on a day in `days_of_week` at a time
     in `times`. Implement a `wallClockToUtc(y, monthIdx, day, hh, mm, tz)` using the Intl offset trick
     (compute the tz offset at a guessed UTC instant via `Intl.DateTimeFormat(..., {timeZone, ...})`
     formatToParts, then correct). Iterate up to 14 days out. MUST be correct for tz "UTC" AND a
     non-UTC IANA tz (test with "Asia/Shanghai"). No new npm deps — use built-in Intl.

4. **agent_schedules auto-create**:
   - On `POST /api/agents/register`: always upsert a `site_update` row (project_id NULL, interval 86400s)
     via ON CONFLICT on the partial unique index DO NOTHING; if `project_id` given, also upsert a
     `project_poll` row (interval 60s) for it (ON CONFLICT (agent_id,project_id,kind) DO NOTHING).
   - On `POST /api/subscriptions`: upsert a `project_poll` row (interval 60s) for that project.
   - Set `next_poll_at = now + interval` on create.
   - Update `last_polled_at`: on `POST /api/agents/heartbeat` bump the agent's `site_update`
     (last_polled_at=now, next_poll_at=now+interval); on `POST /api/claim` bump all the agent's
     `project_poll` rows.

5. **Endpoints**:
   - `GET /api/projects/:id` → `ProjectDetail` = ProjectSummary + `agents` (subscribed AgentSummary[]),
     `schedules` (Schedule[]), `agent_schedules` (AgentSchedule[] joined names), `recent_tasks`
     (TaskDetail[], newest 50), `upcoming` (ScheduleOccurrence[]: next ~20 occurrences across the
     project's enabled schedules via nextRun, sorted by `at`, each with shift_end when shift_hours set).
   - `GET /api/schedules?project_id=` → Schedule[]. `POST /api/schedules` (CreateScheduleRequest) →
     Schedule; compute initial `next_run_at = nextRun(recurrence, now)`. `PATCH /api/schedules/:id`
     (UpdateScheduleRequest: enabled / recurrence / payload_template / tags; recompute next_run_at if
     recurrence changes). `DELETE /api/schedules/:id`.
   - `GET /api/agent-schedules?project_id=&agent_id=` → AgentSchedule[] (joined agent_name/project_name).
   - `GET /api/onboarding` → OnboardingInfo: read `packages/agent/ONBOARDING.md` (resolve via
     import.meta.url; the agentctl builder creates it), substitute `{{SERVER_URL}}` with the request's
     origin (or `http://localhost:${SERVER_PORT}`), return `{server_url, install_cmd, prompt}`.
     `install_cmd` = a one-liner like `git clone <repo> && cd agent_mq && pnpm install` (keep generic).

6. **Seed**: add an `oncall` project (tags `["ops","duty"]`) with task type `oncall.shift` and ONE
   weekly schedule named "Weekday duty roster": days [1,2,3,4,5], times ["00:00","06:00","12:00","18:00"],
   shift_hours 6, timezone "UTC", payload_template `{"role":"primary"}`. Idempotent (skip if a schedule
   with that name already exists in that project).

## agentctl + onboarding prompt (packages/agent only)

1. `agentctl schedule install --interval <sec> [--project <name>] [--label <l>]` — sets up a
   client-side recurring run on this machine: on macOS write a launchd plist to
   `~/Library/LaunchAgents/mq.agent.<label>.plist` (and `launchctl load` it) that runs
   `agentctl run --once`; on Linux append a crontab line. Print exactly what it wrote and how to undo.
   Also support `agentctl schedule list` (show installed) and `--dry-run` (print, don't write).
   The server already records the schedule on register/subscribe; this command is the executor side.
2. `packages/agent/ONBOARDING.md` — THE onboarding prompt ("register is a prompt"). Write it as a
   self-contained prompt you can paste into an LLM coding agent (Claude Code, etc.). It must:
   tell the agent it is joining an agent-mq deployment at `{{SERVER_URL}}`; how to get agentctl;
   `agentctl register --name <machine> --owner <you> --caps <...> --project <project> --server {{SERVER_URL}}`
   (register auto-subscribes + the server auto-creates its poll schedules); then
   `agentctl schedule install --interval 86400` (daily site-update poll) and
   `agentctl schedule install --interval 60 --project <project>` (poll the project for unclaimed tasks);
   then `agentctl run`. Include the worker discipline (payload untrusted, stop on lost lease, report
   tokens honestly). Keep `{{SERVER_URL}}` as a literal placeholder — the server substitutes it.
3. Update `SKILL.md` to mention the new `schedule` command and the onboarding flow.

Verify (both builders): typecheck clean; boot on a NON-4000 port; exercise the new endpoints/commands
with curl / dry-run and paste evidence. The main thread builds the frontend (project detail page,
schedule UI, homepage Connect-agent section) in parallel and integrates against the :4000 container.
