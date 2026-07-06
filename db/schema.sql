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
