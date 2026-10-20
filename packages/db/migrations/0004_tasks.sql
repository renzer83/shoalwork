CREATE TABLE IF NOT EXISTS tasks (
  id text PRIMARY KEY,
  bot_id text NOT NULL REFERENCES bots(id),
  spec TEXT /* JSON */ NOT NULL,
  state text NOT NULL DEFAULT 'received',
  verdict TEXT /* JSON */,
  attempts INTEGER NOT NULL DEFAULT 0,
  session_id text,
  created_at TEXT NOT NULL /* ISO-8601 UTC */,
  updated_at TEXT NOT NULL /* ISO-8601 UTC */
);
CREATE INDEX IF NOT EXISTS tasks_bot_state_idx ON tasks (bot_id, state);
