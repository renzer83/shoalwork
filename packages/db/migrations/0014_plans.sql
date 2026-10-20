-- Plans the Planner built for complex tasks (T-048). `plan` is the JSON of a validated Plan; a task has at most one.
CREATE TABLE IF NOT EXISTS plans (
  id text PRIMARY KEY,
  task_id text NOT NULL UNIQUE REFERENCES tasks(id),
  plan TEXT /* JSON */ NOT NULL,
  state text NOT NULL DEFAULT 'ready',
  created_at TEXT NOT NULL /* ISO-8601 UTC */
);
