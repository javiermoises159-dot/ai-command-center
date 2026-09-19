-- AI Command Center — initial schema.
--
-- Relationships:
--   missions 1───n mission_runs 1───n mission_agents
--
-- `mission_agents.mission_id` is denormalised alongside `run_id` so the mission
-- timeline can be queried without joining through runs. The composite foreign
-- key on (run_id, mission_id) makes the denormalisation impossible to corrupt:
-- an agent row cannot point at a run belonging to a different mission.

CREATE TABLE IF NOT EXISTS missions (
  id           uuid        PRIMARY KEY,
  prompt       text        NOT NULL,
  title        text        NOT NULL,
  status       text        NOT NULL DEFAULT 'pending',
  final_result text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT missions_status_check CHECK (status IN ('pending', 'running', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS missions_created_at_idx ON missions (created_at DESC);
CREATE INDEX IF NOT EXISTS missions_status_idx     ON missions (status);

CREATE TABLE IF NOT EXISTS mission_runs (
  id           uuid        PRIMARY KEY,
  mission_id   uuid        NOT NULL REFERENCES missions (id) ON DELETE CASCADE,
  attempt      integer     NOT NULL,
  status       text        NOT NULL DEFAULT 'pending',
  provider_id  text        NOT NULL,
  model        text        NOT NULL,
  final_result text,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  completed_at timestamptz,
  CONSTRAINT mission_runs_status_check CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  CONSTRAINT mission_runs_attempt_positive CHECK (attempt > 0),
  -- One attempt number per mission; also the target of the composite FK below.
  CONSTRAINT mission_runs_mission_attempt_key UNIQUE (mission_id, attempt),
  CONSTRAINT mission_runs_id_mission_key      UNIQUE (id, mission_id)
);

CREATE INDEX IF NOT EXISTS mission_runs_mission_idx ON mission_runs (mission_id, attempt DESC);
-- Partial index: the boot-time sweep for orphaned runs only ever looks at these.
CREATE INDEX IF NOT EXISTS mission_runs_active_idx  ON mission_runs (status)
  WHERE status IN ('pending', 'running');

CREATE TABLE IF NOT EXISTS mission_agents (
  id                uuid        PRIMARY KEY,
  mission_id        uuid        NOT NULL,
  run_id            uuid        NOT NULL,
  agent_id          text        NOT NULL,
  name              text        NOT NULL,
  order_index       integer     NOT NULL,
  status            text        NOT NULL DEFAULT 'pending',
  task              text        NOT NULL,
  result            text,
  error             text,
  usage_provider    text,
  usage_model       text,
  usage_request_id  text,
  usage_prompt_tokens     integer,
  usage_completion_tokens integer,
  usage_total_tokens      integer,
  usage_latency_ms        integer,
  started_at        timestamptz,
  completed_at      timestamptz,
  CONSTRAINT mission_agents_status_check
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
  -- Guarantees run_id and mission_id always agree.
  CONSTRAINT mission_agents_run_fk
    FOREIGN KEY (run_id, mission_id) REFERENCES mission_runs (id, mission_id) ON DELETE CASCADE,
  CONSTRAINT mission_agents_run_order_key UNIQUE (run_id, order_index)
);

CREATE INDEX IF NOT EXISTS mission_agents_run_idx     ON mission_agents (run_id, order_index);
CREATE INDEX IF NOT EXISTS mission_agents_mission_idx ON mission_agents (mission_id);
