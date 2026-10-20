-- Pods: one chat group per approved plan (T-049). `bot_ids` is a JSON array of Bot ids (fixed and auxiliary);
-- `thread_id` is the Telegram forum topic of the Pod. One Pod per plan, like plans.task_id.
CREATE TABLE IF NOT EXISTS pods (
  id text PRIMARY KEY,
  task_id text NOT NULL UNIQUE REFERENCES tasks(id),
  bot_ids TEXT /* JSON array */ NOT NULL,
  thread_id INTEGER NOT NULL,
  state text NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL /* ISO-8601 UTC */,
  closed_at TEXT /* ISO-8601 UTC */
);
