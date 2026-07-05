# agent-mq

A **distributed agent management system** — a Postgres-backed **pull task queue** for running
work across your teammates' machines. Publish tasks from a web console; workers on colleague
laptops pull them via a scheduled `agentctl`, run them, and report results + token usage back to
a live **dispatch board**.

> Concept map: **Project = Topic · Task = Message · Agent = Consumer · Group = Consumer Group.**
> Routing is **FIFO + capability hard-filter + per-machine concurrency limit** — no scoring, no
> reputation. Reported metrics are display-only and never bias who gets the work. The design and
> the reasoning behind cutting the scoring system live in `docs/` (copied from the design docs).

Three parts:

| Part | What it is | Where |
|---|---|---|
| **Server** | Fastify + Postgres control plane: register / subscribe / **claim** / heartbeat / complete / reaper / dashboards / live SSE | `packages/server` |
| **Web console** | The "dispatch control room" — live board (Pending → Running → Done), Fleet, Projects, Queue, Publish | `packages/web` |
| **agentctl** | The worker CLI colleagues run (pull model, handler plugins, mock LLM handlers for zero-key demo) | `packages/agent` |

The heart is one SQL statement — an atomic `FOR UPDATE OF t SKIP LOCKED` claim that gives an
agent the **oldest** task it is **capable** of running, while it is **under its concurrency
limit**, and never hands the same task to two machines. See `db/schema.sql` and
`packages/server/src/claim.ts`.

## Run it (Docker — recommended)

Requires Docker. One command brings up Postgres, applies the schema, seeds demo
projects/task-types, and starts the API (`:4000`) + web console (`:5173`):

```bash
docker compose up --build
# open http://localhost:5173  → hit "Live"
```

Add a demo worker so the board actually moves:

```bash
docker compose --profile demo up --build   # + a docker-agent that pulls and runs tasks
```

Then open the **Publish** tab, set a burst count (e.g. 30), and watch the dispatch board.

## Run it (host / dev)

Requires Node 20+, pnpm, and Docker (for Postgres only).

```bash
cp .env.example .env
pnpm install
pnpm db:up            # postgres in docker
node scripts/wait-for-db.mjs
pnpm migrate          # apply db/schema.sql
pnpm seed             # demo projects + task types
pnpm dev              # server :4000 + web :5173

# in another shell — become a worker (a "colleague machine"):
pnpm agentctl register  --name mac-01 --owner you --caps shell,gpu,cpu
pnpm agentctl subscribe --project research
pnpm agentctl subscribe --project content
pnpm agentctl run --allow-shell

# in another shell — stream demo work onto the board:
pnpm demo
```

## The web console

- **Overview** — 6 KPIs, the live dispatch board (tasks flow across machine lanes with a
  running progress signal), and the SSE signal log.
- **Fleet** — every registered machine: capabilities, in-flight / concurrency, completed count,
  tokens, work time, cost, online status. Click a row for history.
- **Projects** — per-topic backlog depth (pending / running / completed / dead), how many
  subscribed agents are eligible, consumer groups. Create projects and task types here.
- **Queue** — filterable task table with a drilldown (payload, result, metrics); requeue
  dead-letters, cancel in-flight.
- **Publish** — publish tasks with a live payload preview and a plain-English routing explainer.

## Reliability (built in)

Lease + heartbeat, a **reaper** (advisory-lock leader-elected) that reclaims tasks from slept /
crashed machines, failure **backoff** via `visible_after` (so a poison task can't jam the queue
head), a **dead-letter** state for tasks past `max_retries`, and `dedup_key` idempotency.

## Layout

```
packages/shared   shared TypeScript contract (types + API routes)
packages/server   Fastify API, claim, reaper, SSE, migrate, seed, demo
packages/web      React + Vite dispatch console
packages/agent    agentctl worker CLI + handler plugins + SKILL.md
db/schema.sql     the schema
docs/             the original design docs
BUILD-CONTRACT.md the spec every part is built against
```

## Status / scope

Implements design **phases 1–2**: the queue, claim algorithm, reliability, dashboards, live
board, CLI, and skill. **Phase 3** (secure execution: object-storage I/O, egress proxy with
server-side token metering, container isolation) is documented in `docs/任务可移植性与安全执行设计.md`
and reserved in the schema (`task_types.runtime_image`, `resource_limits`) but not yet enforced —
run agent-mq among trusted machines for now.
