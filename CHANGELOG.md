# Changelog

All notable changes to **agent-mq** are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); dates are `YYYY-MM-DD`.

> Concept map: **Project = Topic · Task = Message · Agent = Consumer · Group = Consumer Group.**
> Routing is FIFO + capability hard-filter + per-consumer concurrency — no scoring, no reputation.

## [0.1.0] — 2026-07-06

The first end-to-end cut: a Postgres-backed pull task queue with a live web console, a
worker CLI teammates run, multi-tenant spaces with RBAC, recurring schedules, and a
Claude Code plugin. Built as a TypeScript pnpm monorepo (`packages/{shared,server,web,agent}`),
run with one `docker compose up`.

### Broker & queue core
- **Postgres schema** for the pull queue — consumers, topics, groups, subscriptions,
  task-types, messages, results, metrics. The claim is one atomic statement:
  `FOR UPDATE OF t SKIP LOCKED`, capability hard-filter (`<@`), `ORDER BY priority DESC,
  created_at ASC` — oldest capable message, never double-dispatched. (`dce81cf`)
- **Fastify control plane** — register / subscribe / **claim** / heartbeat / complete /
  nack, plus a lease **reaper** (advisory-locked) that re-queues messages whose consumer
  stopped heart-beating. Live updates over **SSE**. (`90629c4`)
- **Worker CLI** — pull loop, handler plugins, and mock LLM handlers so the board moves
  with zero API keys. (`822d3be`)
- **Web dispatch console** — live board (Queued → In-flight → Acked), fleet, topics,
  queue, publish. (`42aaa71`)
- **One-command Docker stack** — Postgres → migrate → API (`:4000`) + web (`:5173`),
  plus a `demo` profile that runs a worker so the board moves out of the box. (`181a538`)

### Topics, tags, scheduling & calendar
- Tags on topics and messages; message **type + tags**; per-topic **activity** feed and a
  platform-wide **activity calendar**; `scheduled_for` future messages. (`67be3c4`, `73cccdc`, `b1cce06`)
- **Light theme**, in-UI **consumer registration**, tag filters. (`b1cce06`)

### Recurring schedules & on-call
- **Recurring schedules** (interval + weekly day/time, timezone-correct) with a server
  ticker that produces messages on cadence; **on-call roster** (Mon–Fri, 6h shifts);
  consumer poll schedules + a 24h "subscribe to site updates" schedule; onboarding docs. (`f6fed48`, `177b5bf`)

### Multi-tenant: auth, spaces & RBAC
- **Users** (scrypt passwords, httpOnly session cookie), register / login / logout. (`177b5bf`)
- **Spaces** — Private / Team / Public with **RBAC** (owner/admin/member/viewer). Each user
  gets exactly one private space; the platform has exactly one public space (enforced by a
  partial unique index). (`55ca830`, `177b5bf`, `002212f`, `2cc17d2`)
- Permission chain **user → space → consumer → topic**: consumers belong to a space; claiming
  a topic requires membership. (`002212f`, `2cc17d2`)

### Rest windows & task hand-off
- Per-consumer **rest windows** and **pause** — global or scoped to one topic — honored inside
  the claim so a resting consumer is skipped. (`177b5bf`)
- **Stop an in-flight message and reassign** it to another consumer, resuming from a
  checkpoint (`state` / `assign_to_agent_id` / `progress`). (`177b5bf`)

### Information architecture & MQ terminology
- **Two-level navigation** — a space switcher + level-1 space-global nav (Overview / My work /
  Topics / Consumers / Members / Activity) and a level-2 per-topic sub-menu (Overview / Queue /
  Messages / Produce / Consumers / Schedules / Activity / Calendar). (`05f7c38`, `a872eba`)
- **Topic master-detail** pages; site-wide **MQ terminology** (Broker / Topic / Message /
  Consumer / Produce; statuses QUEUED / LEASED / IN-FLIGHT / ACKED / NACKED / DEAD-LETTER);
  queue ordered by priority then time. (`a872eba`)
- **My-work dashboard**; Overview, Consumers, and Activity all scoped to the current space. (`3eda78f`, `ba6f981`)

### agent-mq CLI
- Renamed `agentctl` → **`agent-mq`** across the codebase and root tooling. (`e557c64`, `69f732b`)
- **User login / whoami / logout**; `register --space` binds a consumer to a space. (`824f5c9`)

### Claude Code plugin
- **agent-mq marketplace + `agentmq-worker` skill** — installable via
  `/plugin marketplace add KaneBetter/agent_mq`, so a Claude Code agent can self-register,
  subscribe, and set up its own poll schedule from one prompt. (`69d6986`)

### Fixes
- Register-consumer now sends `space_id` (required post-multi-tenant), and `run-cmd` logs in
  first. (`3e9bbf3`)
- CLI login reads distinct username/password lines from piped stdin. (`e793784`)
- Board signal cards no longer clip — flex was shrinking them to 18px. (`1f92d89`)

### UI simplification
- **Calmer surface** — dropped the blueprint-grid + glow background, removed ALL-CAPS labels,
  tightened the wide HUD letter-spacing, softened accent glows to plain shadows. (`774a1d2`)
- **Plainer type** — one calm sans family (IBM Plex Sans for headings *and* body, replacing the
  techy Chakra Petch); monospace pulled back from ~40 uses to 9 (code, tokens, IDs, numeric
  columns, clock, type identifiers only). (`cbf221f`)

---

Design rationale — the pull-queue model, why scoring was cut, and the task-portability /
secure-execution design — lives in [`docs/`](docs/) and [`BUILD-CONTRACT.md`](BUILD-CONTRACT.md).
