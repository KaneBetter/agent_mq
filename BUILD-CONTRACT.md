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
    agent/                @agentmq/agent — agent-mq CLI (YOU MAY BUILD)
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

## Agent package (@agentmq/agent) — `agent-mq`

`packages/agent/package.json`:
- `bin`: `{ "agent-mq": "./src/cli.ts" }` (run via tsx; also expose `start` script → `tsx src/cli.ts`).
- scripts: `start` → `tsx src/cli.ts`.
- Deps: `@agentmq/shared` (workspace:*). Dev: `tsx`, `typescript`, `@types/node`. Use built-in `fetch` (Node 25) — no axios.

State: persist `{ server, agent_id, api_token }` to `./.agent-mq/config.json` (cwd) or `~/.agent-mq/config.json`; allow `--server` / `AGENTMQ_SERVER` (default `http://localhost:4000`).

Commands (mirror the SKILL.md command surface):
- `agent-mq register --name <n> [--owner o] [--caps a,b] [--max-concurrency k] [--server url]`
- `agent-mq subscribe --project <id|name> [--group <name>]`
- `agent-mq claim` — claim one, print it.
- `agent-mq heartbeat` — agent-level heartbeat.
- `agent-mq complete <task_id> --status success|failure [--result json] [--tokens in,out] [--model m]`
- `agent-mq fail <task_id> [--error msg]`
- `agent-mq run [--once] [--interval sec] [--concurrency k]` — the real worker loop:
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
pnpm agent-mq register --name mac-01 --caps shell,gpu --owner alice
pnpm agent-mq subscribe --project research
pnpm agent-mq run
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
     import.meta.url; the agent-mq builder creates it), substitute `{{SERVER_URL}}` with the request's
     origin (or `http://localhost:${SERVER_PORT}`), return `{server_url, install_cmd, prompt}`.
     `install_cmd` = a one-liner like `git clone <repo> && cd agent_mq && pnpm install` (keep generic).

6. **Seed**: add an `oncall` project (tags `["ops","duty"]`) with task type `oncall.shift` and ONE
   weekly schedule named "Weekday duty roster": days [1,2,3,4,5], times ["00:00","06:00","12:00","18:00"],
   shift_hours 6, timezone "UTC", payload_template `{"role":"primary"}`. Idempotent (skip if a schedule
   with that name already exists in that project).

## agent-mq + onboarding prompt (packages/agent only)

1. `agent-mq schedule install --interval <sec> [--project <name>] [--label <l>]` — sets up a
   client-side recurring run on this machine: on macOS write a launchd plist to
   `~/Library/LaunchAgents/mq.agent.<label>.plist` (and `launchctl load` it) that runs
   `agent-mq run --once`; on Linux append a crontab line. Print exactly what it wrote and how to undo.
   Also support `agent-mq schedule list` (show installed) and `--dry-run` (print, don't write).
   The server already records the schedule on register/subscribe; this command is the executor side.
2. `packages/agent/ONBOARDING.md` — THE onboarding prompt ("register is a prompt"). Write it as a
   self-contained prompt you can paste into an LLM coding agent (Claude Code, etc.). It must:
   tell the agent it is joining an agent-mq deployment at `{{SERVER_URL}}`; how to get agent-mq;
   `agent-mq register --name <machine> --owner <you> --caps <...> --project <project> --server {{SERVER_URL}}`
   (register auto-subscribes + the server auto-creates its poll schedules); then
   `agent-mq schedule install --interval 86400` (daily site-update poll) and
   `agent-mq schedule install --interval 60 --project <project>` (poll the project for unclaimed tasks);
   then `agent-mq run`. Include the worker discipline (payload untrusted, stop on lost lease, report
   tokens honestly). Keep `{{SERVER_URL}}` as a literal placeholder — the server substitutes it.
3. Update `SKILL.md` to mention the new `schedule` command and the onboarding flow.

Verify (both builders): typecheck clean; boot on a NON-4000 port; exercise the new endpoints/commands
with curl / dry-run and paste evidence. The main thread builds the frontend (project detail page,
schedule UI, homepage Connect-agent section) in parallel and integrates against the :4000 container.

---

# v5 delta — users/auth, spaces + RBAC, agent rest, stop/reassign/checkpoint

Schema already migrated: tables `users, sessions, spaces, space_members, agent_rest_windows`;
columns `projects.space_id`, `agents.owner_user_id/paused`, `subscriptions.paused`,
`tasks.state/assign_to_agent_id/progress`. Shared types already added (User, Space*, SpaceRole,
SpaceVisibility, RestWindow, auth/stop/reassign DTOs, MyOverview, Project.space_id, Agent.paused,
Task.state/assign_to_agent_id/progress, AgentSummary.resting, new API_ROUTES). Do NOT edit shared/schema.

Locked decisions: lightweight local accounts (username+password); spaces with owner+members+roles
(admin/member/viewer); rest = recurring windows + manual pause (global + per-topic); stop = release
lease → QUEUED keeping `state` checkpoint; reassign = targeted `assign_to_agent_id`.

## Constraints
- NO new npm deps. Passwords: `node:crypto` `scryptSync` with a random salt, store `salt:hex`.
  Session token: `crypto.randomBytes(32).hex`. Cookie: handle manually — read `request.headers.cookie`,
  set `Set-Cookie: mq_session=<token>; HttpOnly; SameSite=Lax; Path=/; Max-Age=...`. Logout clears it.
- CORS: configure @fastify/cors with `{ origin: true, credentials: true }` (echoes origin + allows
  cookies). Update the SSE raw-header CORS block to also send `Access-Control-Allow-Credentials: true`
  and echo the origin (already does).

## Auth (packages/server)
- `POST /api/auth/register` (RegisterUserRequest) → create user (scrypt hash), create a session, set
  cookie, return AuthResponse. First-ever user is fine as a normal user.
- `POST /api/auth/login` (LoginRequest) → verify, new session + cookie, AuthResponse. 401 on bad creds.
- `POST /api/auth/logout` → delete session, clear cookie.
- `GET /api/auth/me` → AuthResponse or 401.
- Middleware `getUser(request)`: resolve user from the `mq_session` cookie. Also accept the
  `ADMIN_TOKEN` bearer as a superuser bypass (for scripts/demo/feeder). Agent endpoints keep their
  own bearer-token auth (unchanged).

## Spaces + RBAC
- `spaces` own topics + consumers. `GET /api/spaces` → SpaceSummary[] the user can see (member-of OR
  public). `POST /api/spaces` (CreateSpaceRequest) → create, owner=current user, add owner as admin
  member. `GET /api/spaces/:id` → SpaceDetail (members). `PATCH` (owner/admin). `DELETE` (owner).
- Members: `GET/POST /api/spaces/:id/members` (AddMemberRequest — add by username), `PATCH/DELETE
  /api/spaces/:id/members/:userId`. Only owner/admin manage members.
- RBAC rules (enforce on the relevant endpoints):
  - view a space + its topics: member (any role) OR space is public.
  - produce messages / create topics / register consumers in a space: member with admin|member.
  - manage space + members + visibility: owner or admin.
  - viewer = read-only.
- Scope existing endpoints to spaces the caller can see:
  - `POST /api/projects` now requires `space_id` (add to the create path) + admin|member of that space.
  - `GET /api/projects`, `/api/projects/:id`, `/api/tasks`, `/api/activity`, `/api/calendar`,
    dashboards: filter to topics in spaces the caller can view (public or member). The ADMIN_TOKEN
    superuser sees everything (so the demo/feeder keeps working).
  - `POST /api/tasks` (produce): require admin|member of the topic's space (ADMIN_TOKEN bypass).
- Map `Project.space_id/space_name` in the project mappers.

## Bootstrap / seed
- Seed a demo user `demo` / password `demo` (scrypt) if absent. Create a default **public** space
  "Demo Space" owned by demo, add demo as admin. Backfill: any topic with `space_id IS NULL` →
  the demo space. So after logging in as demo (or via ADMIN_TOKEN) the existing topics show up.

## Agent rest / pause (claim integration)
- `POST /api/agents/:id/pause` (SetAgentPauseRequest) → set `agents.paused`.
- `GET/POST /api/agents/:id/rest-windows` (CreateRestWindowRequest), `DELETE .../:windowId`.
- `POST /api/agents/:id/subscription-pause` (SetSubscriptionPauseRequest {project_id,paused}) →
  set `subscriptions.paused` for that (agent,project).
- A consumer is **resting for a topic** if: `agents.paused` true, OR a global rest window
  (project_id NULL) is active now, OR the subscription for that topic is paused, OR a topic-scoped
  rest window is active now. "Active now" = weekday ∈ days_of_week AND current local time (in the
  window tz) ∈ [start_time, end_time). Reuse the tz helper from scheduling.ts.
- **Claim change**: the claim SQL/flow must skip a consumer entirely when globally paused/resting,
  and skip a topic's tasks when that subscription is paused or a topic rest window is active. Simplest
  correct approach: compute the resting/paused state in the claim handler (before/around the claim)
  and exclude the relevant `project_id`s from the claim query (e.g. pass an allowed-projects array),
  or return 204 when globally paused. Keep FIFO + capability + concurrency intact.
- `AgentSummary.resting` = any global rest active now OR agents.paused. Map `agents.paused/owner_user_id`.

## Stop / reassign / checkpoint
- `POST /api/tasks/:id/checkpoint` (agent bearer; must hold lease) → save `state`/`progress` on the task.
- `POST /api/tasks/:id/stop` (user auth; StopTaskRequest) → release lease: status→PENDING, clear
  assigned_agent_id/lease, KEEP `state`; if `assign_to_agent_id` given set it (targeted). Emit an
  activity event. The running consumer will see 409 on next heartbeat and abort.
- `POST /api/tasks/:id/reassign` (user auth; ReassignTaskRequest {agent_id}) → set
  `assign_to_agent_id`, ensure status PENDING (release lease if in-flight), keep `state`.
- **Claim change**: honor `assign_to_agent_id` — a task with it set is only claimable by that agent;
  a task with it NULL is claimable normally. Return `state`/`progress` on the ClaimedTask so the
  consumer resumes.
- Map `state/assign_to_agent_id/progress` in the task mappers; include in TaskDetail + ClaimedTask.

## My dashboard
- `GET /api/me/overview` → MyOverview: my spaces, topics in my spaces, my consumers (owner_user_id
  = me), and recent tasks my consumers ran.

Verify (paste evidence): typecheck; migrate+seed; boot on 4996; register a user (cookie set), login,
me; create a space, add a member, create a topic in it, produce a message; a non-member is 403 on
produce and doesn't see private topics; pause a consumer and confirm claim returns 204 for it; set a
rest window and confirm resting; stop an in-flight task (state preserved, back to PENDING) and reassign
to a specific consumer (only that consumer claims it, and receives `state`). Keep ADMIN_TOKEN bypass
working (curl with `Authorization: Bearer dev-admin` still sees everything). Kill the test server after.

---

# v6 delta — consumer↔space binding, default private/public spaces, CLI login

Schema migrated: `agents.space_id` + a partial unique index enforcing ONE public space.
Shared types updated: `Agent.space_id/space_name`, `RegisterAgentRequest.space_id`. Do NOT edit shared/schema.

Model (locked with the user): every user has exactly ONE private space (auto-created on register);
the platform has exactly ONE public space all users can read; team spaces are created explicitly.
A consumer belongs to exactly one space; user → (member of space) → register consumer into space →
subscribe to topics in that space.

## Server refinements (packages/server)
1. Map `Agent.space_id` + `space_name` (join) in the agent mappers (list + detail + AgentSummary).
2. `POST /api/agents/register` now REQUIRES an authenticated caller (session cookie OR ADMIN_TOKEN
   bearer) AND `space_id`. 401 if no auth; 400 if no space_id; 403 if the user isn't admin|member of
   that space (ADMIN_TOKEN bypasses). Set `agents.space_id` + `owner_user_id` (the session user; null
   for ADMIN_TOKEN). If `project_id` given it must be a topic in that space (else 400); auto-subscribe.
3. Default spaces:
   - `POST /api/auth/register` (user signup): after creating the user, auto-create their private space
     named `"<display_name or username>'s space"` (visibility `private`, owner = the user, add them as
     `admin` member). Idempotent-ish (one private space per user; if they already have one, skip).
   - Ensure exactly ONE public space exists at boot (call an ensurePublicSpace() on startup or in seed):
     name it `"Public"` (owner NULL/system). All users can view it (public visibility already grants view).
   - `POST /api/spaces` creates TEAM spaces only — force `visibility: 'team'` (ignore/deny private|public
     from the client). Private is auto; public is the singleton.
4. Seed: ensure the single `"Public"` space; keep/convert the old "Demo Space" into it OR create Public
   and move demo's topics there; give the `demo` user a private space via the same auto-create path;
   backfill any orphan (space_id NULL) topics into the Public space.
5. `GET /api/spaces` returns: the user's private space + the Public space + their team spaces (member-of
   or public), each with `my_role` and counts (unchanged shape).

Verify: typecheck; migrate+seed; register a NEW user → they get a private space (GET /api/spaces shows
"<name>'s space"[private/admin] + Public[public]); POST /api/spaces returns a team space (visibility
team even if you asked for public); register a consumer with space_id (as a member) → agent has
space_id; without space_id → 400; not a member → 403. ADMIN_TOKEN register still works. Kill test server.

## agent-mq CLI login (packages/agent)
Add `src/session.ts` + commands. Management calls (register/subscribe/spaces) authenticate as a logged-in
USER (session cookie), distinct from the per-agent Bearer token used by claim/heartbeat/complete.
1. `agent-mq login [--server url] [--username u] [--password p]` — POST `/api/auth/login`; capture the
   `mq_session` value from the response `Set-Cookie` header; store `{ session_token, username }` in the
   config file. If username/password omitted, prompt on stdin (password hidden if practical, else plain).
   Print `logged in as <username>`.
2. `agent-mq whoami` — GET `/api/auth/me` sending `Cookie: mq_session=<token>`; print the user or
   `not logged in`. `agent-mq logout` clears the stored session.
3. API client: send `Cookie: mq_session=<token>` on user/management requests; keep Bearer agent-token on
   claim/heartbeat/complete. Add a `spaces()` call (GET /api/spaces) for `--space` name resolution.
4. `agent-mq register` now requires a stored session (`--space <slug|id>` required): resolve `--space`
   name→id via GET /api/spaces, send `space_id`. If not logged in → clear error `run 'agent-mq login' first`.
5. Update ONBOARDING.md + SKILL.md: the flow is now `agent-mq login` → `agent-mq register --space <s> --project <p> ...` → `schedule install` → `run`.

Verify: typecheck; `agent-mq login --help`, `whoami` with no session prints "not logged in"; dry-run /
help for register shows `--space`. (Full e2e needs the server; the integrator runs it against :4000.)
