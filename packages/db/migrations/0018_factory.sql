-- Dev Factory baseline (T-058): imported bridge history and computed baselines. The imported `agents` array is
-- not stored here (they are the SOULs, imported by T-059 templates and T-038 memory). Upserts are idempotent by
-- (source, id); factory_events dedupe by (source, task_id, type, at).
CREATE TABLE IF NOT EXISTS projects (
  slug text NOT NULL,
  name text NOT NULL,
  repo_url text NOT NULL,
  default_branch text NOT NULL,
  status text NOT NULL /* active | maintenance | done */,
  source text NOT NULL,
  PRIMARY KEY (source, slug)
);
CREATE TABLE IF NOT EXISTS project_tasks (
  id text NOT NULL,
  project text NOT NULL,
  title text NOT NULL,
  issue_number integer,
  pr_number integer,
  state text NOT NULL,
  created_at text NOT NULL /* ISO-8601 UTC */,
  started_at text,
  merged_at text,
  closed_at text,
  retries integer NOT NULL,
  manual_interventions integer NOT NULL,
  tokens_in integer,
  tokens_out integer,
  usd number,
  source text NOT NULL,
  PRIMARY KEY (source, id)
);
CREATE INDEX IF NOT EXISTS project_tasks_project_idx ON project_tasks (project);
CREATE TABLE IF NOT EXISTS factory_events (
  task_id text NOT NULL,
  type text NOT NULL,
  at text NOT NULL /* ISO-8601 UTC */,
  data text /* JSON */,
  source text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS factory_events_dedupe_idx ON factory_events (source, task_id, type, at);
CREATE INDEX IF NOT EXISTS factory_events_task_idx ON factory_events (task_id);
CREATE INDEX IF NOT EXISTS factory_events_at_idx ON factory_events (at);
CREATE TABLE IF NOT EXISTS baselines (
  project text NOT NULL,
  metric text NOT NULL,
  value number NOT NULL,
  window_from text NOT NULL,
  window_to text NOT NULL,
  computed_at text NOT NULL,
  PRIMARY KEY (project, metric, window_from, window_to)
);
