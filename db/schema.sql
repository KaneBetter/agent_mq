-- Distributed Agent Management System — schema (v2: no scoring, FIFO + capability + concurrency)
-- Applied idempotently by packages/server migrate script.
-- Concept map: Project=Topic, Task=Message, Agent=Consumer, Group=Consumer Group.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE task_status AS ENUM ('PENDING','CLAIMED','RUNNING','COMPLETED','FAILED','DEAD');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE agent_status AS ENUM ('online','offline');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE result_status AS ENUM ('success','failure');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Consumers: workers running on colleagues' machines.
CREATE TABLE IF NOT EXISTS agents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  owner             text NOT NULL DEFAULT '',
  machine_info      jsonb NOT NULL DEFAULT '{}'::jsonb,
  capabilities      text[] NOT NULL DEFAULT '{}',
  api_token         text NOT NULL UNIQUE,
  max_concurrency   int  NOT NULL DEFAULT 3 CHECK (max_concurrency >= 1),
  status            agent_status NOT NULL DEFAULT 'offline',
  last_heartbeat_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Topics.
CREATE TABLE IF NOT EXISTS projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  description text NOT NULL DEFAULT '',
  task_schema jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Consumer groups.
CREATE TABLE IF NOT EXISTS groups (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

-- Who subscribes to which project, in which group.
CREATE TABLE IF NOT EXISTS subscriptions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id   uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  group_id   uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, project_id, group_id)
);

-- Task-type registry (keeps task types diverse + extensible).
CREATE TABLE IF NOT EXISTS task_types (
  type                  text PRIMARY KEY,
  description           text NOT NULL DEFAULT '',
  input_schema          jsonb,
  required_capabilities text[] NOT NULL DEFAULT '{}',
  -- Phase-3 secure-execution declarations (reserved; not enforced yet).
  runtime_image         text,
  resource_limits       jsonb,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- Messages.
CREATE TABLE IF NOT EXISTS tasks (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type                  text NOT NULL,
  payload               jsonb NOT NULL DEFAULT '{}'::jsonb,
  priority              int  NOT NULL DEFAULT 0,        -- secondary sort only; default equal => pure FIFO
  required_capabilities text[] NOT NULL DEFAULT '{}',
  target_group_id       uuid REFERENCES groups(id) ON DELETE SET NULL,
  status                task_status NOT NULL DEFAULT 'PENDING',
  retry_count           int  NOT NULL DEFAULT 0,
  max_retries           int  NOT NULL DEFAULT 3,
  assigned_agent_id     uuid REFERENCES agents(id) ON DELETE SET NULL,
  group_id              uuid REFERENCES groups(id) ON DELETE SET NULL,
  claimed_at            timestamptz,
  lease_expires_at      timestamptz,
  visible_after         timestamptz,                    -- failure backoff: not claimable before this
  dedup_key             text,
  last_error            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz
);

-- Idempotent publish.
CREATE UNIQUE INDEX IF NOT EXISTS tasks_dedup_key_uidx
  ON tasks(dedup_key) WHERE dedup_key IS NOT NULL;

-- Hot path for FIFO claim (status + project + priority/created ordering).
CREATE INDEX IF NOT EXISTS tasks_claim_idx
  ON tasks(status, project_id, priority DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS tasks_visible_after_idx
  ON tasks(visible_after) WHERE visible_after IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_lease_idx
  ON tasks(lease_expires_at) WHERE status IN ('CLAIMED','RUNNING');
CREATE INDEX IF NOT EXISTS tasks_assigned_idx ON tasks(assigned_agent_id);

-- Results.
CREATE TABLE IF NOT EXISTS results (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id    uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id   uuid REFERENCES agents(id) ON DELETE SET NULL,
  status     result_status NOT NULL,
  output     jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS results_task_idx ON results(task_id);

-- Telemetry (display only; never feeds routing).
CREATE TABLE IF NOT EXISTS metrics (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id      uuid REFERENCES agents(id) ON DELETE SET NULL,
  project_id    uuid REFERENCES projects(id) ON DELETE SET NULL,
  model         text,
  input_tokens  int NOT NULL DEFAULT 0,
  output_tokens int NOT NULL DEFAULT 0,
  total_tokens  int NOT NULL DEFAULT 0,
  wall_time_ms  int NOT NULL DEFAULT 0,
  cost_usd      numeric(12,6) NOT NULL DEFAULT 0,
  retries       int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS metrics_agent_idx ON metrics(agent_id);
CREATE INDEX IF NOT EXISTS metrics_project_idx ON metrics(project_id);
CREATE INDEX IF NOT EXISTS metrics_created_idx ON metrics(created_at);

-- ── v3: tags, scheduling, persisted activity (idempotent ALTERs) ───────────
ALTER TABLE projects ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';
ALTER TABLE tasks    ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';
-- scheduled_for: when set + future, the task is scheduled and not claimable until then.
ALTER TABLE tasks    ADD COLUMN IF NOT EXISTS scheduled_for timestamptz;

CREATE INDEX IF NOT EXISTS projects_tags_idx ON projects USING gin(tags);
CREATE INDEX IF NOT EXISTS tasks_tags_idx    ON tasks USING gin(tags);
CREATE INDEX IF NOT EXISTS tasks_scheduled_idx
  ON tasks(scheduled_for) WHERE scheduled_for IS NOT NULL;

-- Durable activity log (the persisted form of the live SSE events).
CREATE TABLE IF NOT EXISTS activity (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type       text NOT NULL,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  task_id    uuid REFERENCES tasks(id) ON DELETE SET NULL,
  agent_id   uuid REFERENCES agents(id) ON DELETE SET NULL,
  task_type  text,
  status     text,
  message    text,
  meta       jsonb NOT NULL DEFAULT '{}'::jsonb,
  ts         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activity_ts_idx      ON activity(ts DESC);
CREATE INDEX IF NOT EXISTS activity_project_idx ON activity(project_id, ts DESC);

-- ── v4: recurring schedules + agent polling schedules ──────────────────────
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS schedule_id uuid;

-- Recurring task generators (e.g. on-call rosters). A server ticker spawns a
-- concrete task each time next_run_at arrives, then advances next_run_at.
CREATE TABLE IF NOT EXISTS schedules (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name                  text NOT NULL,
  type                  text NOT NULL,
  payload_template      jsonb NOT NULL DEFAULT '{}'::jsonb,
  tags                  text[] NOT NULL DEFAULT '{}',
  required_capabilities text[] NOT NULL DEFAULT '{}',
  target_group_id       uuid REFERENCES groups(id) ON DELETE SET NULL,
  recurrence            jsonb NOT NULL,   -- {kind, interval_seconds?, days_of_week?, times?, timezone?}
  shift_hours           numeric,          -- duty length; adds shift_start/shift_end to payload
  enabled               boolean NOT NULL DEFAULT true,
  next_run_at           timestamptz NOT NULL,
  last_run_at           timestamptz,
  runs_count            int NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS schedules_next_idx ON schedules(next_run_at) WHERE enabled;
CREATE INDEX IF NOT EXISTS schedules_project_idx ON schedules(project_id);

-- Link generated tasks back to their schedule (nullable FK added after schedules exists).
DO $$ BEGIN
  ALTER TABLE tasks ADD CONSTRAINT tasks_schedule_fk
    FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS tasks_schedule_idx ON tasks(schedule_id) WHERE schedule_id IS NOT NULL;

-- Agent polling schedules: created on register/subscribe, executed client-side
-- (launchd/cron). The site tracks cadence + last poll for visibility.
CREATE TABLE IF NOT EXISTS agent_schedules (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id         uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  project_id       uuid REFERENCES projects(id) ON DELETE CASCADE,  -- null = global site-update poll
  kind             text NOT NULL,          -- 'site_update' | 'project_poll'
  interval_seconds int NOT NULL,
  last_polled_at   timestamptz,
  next_poll_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, project_id, kind)
);
CREATE INDEX IF NOT EXISTS agent_schedules_agent_idx ON agent_schedules(agent_id);
CREATE INDEX IF NOT EXISTS agent_schedules_project_idx ON agent_schedules(project_id);
-- One global site-update schedule per agent (project_id is NULL there, so the
-- table UNIQUE can't enforce it — a partial unique index does).
CREATE UNIQUE INDEX IF NOT EXISTS agent_schedules_site_uidx
  ON agent_schedules(agent_id) WHERE kind = 'site_update';

-- ── v5: users, sessions, spaces + RBAC, agent rest, task checkpoint/reassign ──

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text NOT NULL UNIQUE,
  email         text,
  password_hash text NOT NULL,
  display_name  text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Opaque session tokens (httpOnly cookie) → user.
CREATE TABLE IF NOT EXISTS sessions (
  token      text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

-- Spaces: the outermost tenancy boundary. Topics + consumers belong to a space.
CREATE TABLE IF NOT EXISTS spaces (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  slug       text NOT NULL UNIQUE,
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','team','public')),
  owner_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Space membership + role.
CREATE TABLE IF NOT EXISTS space_members (
  space_id   uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, user_id)
);

-- Topics belong to a space.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS space_id uuid REFERENCES spaces(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS projects_space_idx ON projects(space_id);

-- Consumers: ownership + global manual pause.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS paused boolean NOT NULL DEFAULT false;

-- Per-topic manual pause lives on the subscription.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS paused boolean NOT NULL DEFAULT false;

-- Recurring rest windows (quiet hours). project_id NULL = global (whole consumer).
CREATE TABLE IF NOT EXISTS agent_rest_windows (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  project_id  uuid REFERENCES projects(id) ON DELETE CASCADE,   -- NULL = global
  days_of_week int[] NOT NULL DEFAULT '{}',                     -- 0=Sun..6=Sat
  start_time  text NOT NULL,                                    -- 'HH:MM'
  end_time    text NOT NULL,                                    -- 'HH:MM'
  timezone    text NOT NULL DEFAULT 'UTC',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rest_windows_agent_idx ON agent_rest_windows(agent_id);

-- Task checkpoint (carried across stop/reassign) + targeted reassignment.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS state jsonb;                 -- resume checkpoint
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assign_to_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS progress numeric;           -- 0..1, optional display
CREATE INDEX IF NOT EXISTS tasks_assign_to_idx ON tasks(assign_to_agent_id) WHERE assign_to_agent_id IS NOT NULL;

-- ── v6: consumers belong to a space ────────────────────────────────────────
ALTER TABLE agents ADD COLUMN IF NOT EXISTS space_id uuid REFERENCES spaces(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS agents_space_idx ON agents(space_id);
-- Enforce a single platform-wide public space via a partial unique index on visibility.
CREATE UNIQUE INDEX IF NOT EXISTS spaces_single_public_uidx ON spaces((visibility)) WHERE visibility = 'public';

-- ── v7: agent lifecycle flow — space-level poll, news timeline, join requests ─

-- The 24h "register agent to a space" poll. project_id stays NULL for these;
-- space_id carries the scope. kind is now 'site_update' | 'space_poll' | 'project_poll'.
ALTER TABLE agent_schedules ADD COLUMN IF NOT EXISTS space_id uuid REFERENCES spaces(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS agent_schedules_space_idx ON agent_schedules(space_id);
-- One space_poll per (agent, space); the table UNIQUE can't enforce it because
-- project_id is NULL for space_poll rows (NULLs are distinct), so use a partial index.
CREATE UNIQUE INDEX IF NOT EXISTS agent_schedules_space_uidx
  ON agent_schedules(agent_id, space_id) WHERE kind = 'space_poll';

-- The site's update "news timeline". A connected agent reads this on its 24h
-- site_update poll (`agent-mq updates`); the console renders it as "Updates".
CREATE TABLE IF NOT EXISTS site_updates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title        text NOT NULL,
  body         text NOT NULL DEFAULT '',
  category     text NOT NULL DEFAULT 'announcement'
                 CHECK (category IN ('release','announcement','incident','deprecation')),
  published_at timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS site_updates_published_idx ON site_updates(published_at DESC);

-- Self-service "apply to join a space". Approving grants membership; neither
-- applying nor approving ever creates a schedule task.
CREATE TABLE IF NOT EXISTS space_join_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id    uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
  message     text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz,
  decided_by  uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS space_join_requests_space_idx ON space_join_requests(space_id, status);
-- At most one live (pending) request per (space, user); re-applying after a
-- decision is allowed because decided rows fall outside this partial index.
CREATE UNIQUE INDEX IF NOT EXISTS space_join_requests_pending_uidx
  ON space_join_requests(space_id, user_id) WHERE status = 'pending';
