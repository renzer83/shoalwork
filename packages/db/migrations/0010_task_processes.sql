CREATE TABLE IF NOT EXISTS task_processes (
  task_id text NOT NULL,
  pgid INTEGER NOT NULL /* process group id of a Tank process started by the task's run */,
  started_at TEXT NOT NULL /* ISO-8601 UTC */,
  PRIMARY KEY (task_id, pgid)
);
