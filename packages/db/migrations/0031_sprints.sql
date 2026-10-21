-- Sprints of a project's board (T-115): a named time box the board filters its tasks by. A task belongs to one
-- sprint or to none (sprint_id NULL). Every change is an event on the project stream (sprint.created,
-- project_task.sprint_changed); these rows are the projection.
CREATE TABLE IF NOT EXISTS sprints (
  id text PRIMARY KEY,
  project text NOT NULL,
  name text NOT NULL,
  starts_at text NOT NULL /* ISO-8601 UTC */,
  ends_at text NOT NULL /* ISO-8601 UTC */,
  goal text NOT NULL
);
CREATE INDEX IF NOT EXISTS sprints_project_idx ON sprints (project, starts_at);
ALTER TABLE project_tasks ADD COLUMN sprint_id text;
