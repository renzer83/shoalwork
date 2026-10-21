-- Replays (T-122): a task re-run from the log, as a NEW task. The row links the source to the new task and keeps what the
-- replay changed (overrides, JSON) and what it starts from: the base commit and whether it reuses the context text of
-- the source (context_snapshots). The run reads this row to apply them; only the Lead writes it.
CREATE TABLE IF NOT EXISTS replays (
  id text PRIMARY KEY,
  source_task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  new_task_id text NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  overrides TEXT /* JSON */ NOT NULL,
  base_sha text,
  -- The executor a model override applies to: the override's executor, else the one the source ran on.
  model_executor text,
  context_frozen INTEGER NOT NULL DEFAULT 0 CHECK (context_frozen IN (0, 1)),
  created_at TEXT NOT NULL /* ISO-8601 UTC */
);
CREATE INDEX IF NOT EXISTS replays_source_idx ON replays (source_task_id);

-- The context text a run was given (T-041, T-122): what a replay reuses so that both runs see the same briefing.
-- One row per task, the FIRST attempt's (INSERT OR IGNORE); secrets redacted; removed with the task. Only a replay reads it.
CREATE TABLE IF NOT EXISTS context_snapshots (
  task_id text PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  text text NOT NULL,
  level text NOT NULL,
  used INTEGER NOT NULL,
  budget INTEGER NOT NULL,
  created_at TEXT NOT NULL /* ISO-8601 UTC */
);
