-- MADRE artefacts: plans, run state, QA verdicts, cost records, approvals,
-- memory entries and audit events.
--
-- One generic table instead of one per artefact. The relational core
-- (missions / mission_runs / mission_agents) is untouched by this migration, and
-- every kind stays queryable by mission, run, scope and time through the
-- indexes below. `payload` is the artefact itself, validated by the
-- application; the database only guarantees it is JSON.
--
-- Additive and idempotent: it creates one table and nothing else.

CREATE TABLE IF NOT EXISTS madre_documents (
  kind        text        NOT NULL,
  id          text        NOT NULL,
  mission_id  uuid        REFERENCES missions (id) ON DELETE CASCADE,
  run_id      uuid        REFERENCES mission_runs (id) ON DELETE CASCADE,
  scope       text,
  payload     jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT madre_documents_pkey PRIMARY KEY (kind, id),
  CONSTRAINT madre_documents_kind_nonempty CHECK (length(kind) > 0)
);

CREATE INDEX IF NOT EXISTS madre_documents_mission_idx ON madre_documents (mission_id, kind, created_at);
CREATE INDEX IF NOT EXISTS madre_documents_run_idx     ON madre_documents (run_id, kind, created_at);
CREATE INDEX IF NOT EXISTS madre_documents_kind_idx    ON madre_documents (kind, created_at DESC);
CREATE INDEX IF NOT EXISTS madre_documents_scope_idx   ON madre_documents (kind, scope) WHERE scope IS NOT NULL;
