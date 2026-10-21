-- Issue -> PR -> CI -> testpilot -> review -> merge cycle (T-061). `gates` and `e2e` are JSON arrays of commands
-- (acceptance of the worker and of the testpilot); `auto_merge` lets the cycle merge when the policy allows.
ALTER TABLE projects ADD COLUMN gates text NOT NULL DEFAULT '[]';
ALTER TABLE projects ADD COLUMN e2e text NOT NULL DEFAULT '[]';
ALTER TABLE projects ADD COLUMN auto_merge integer NOT NULL DEFAULT 0;
-- One row per board task that the cycle drives. `current_task_id` is the Lead task that owns the phase,
-- `worker_tasks` (JSON array) every task a worker ran, `since_ms` when the phase began and `checked_ms` when the
-- observer last polled the checks. All times come from the Effect clock.
CREATE TABLE IF NOT EXISTS project_cycles (
  project text NOT NULL,
  task_id text NOT NULL,
  phase text NOT NULL,
  current_task_id text,
  worker_tasks text NOT NULL DEFAULT '[]',
  fixes integer NOT NULL DEFAULT 0,
  ci_signal text,
  since_ms integer NOT NULL DEFAULT 0,
  checked_ms integer,
  approval_id text,
  fix_note text,
  PRIMARY KEY (project, task_id)
);
CREATE INDEX IF NOT EXISTS project_cycles_phase_idx ON project_cycles (project, phase);
-- Where the cycle stopped reading the log (CI results), per project.
CREATE TABLE IF NOT EXISTS project_cycle_cursors (
  project text PRIMARY KEY,
  position integer NOT NULL
);
