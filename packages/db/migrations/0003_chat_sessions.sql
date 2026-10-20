CREATE TABLE IF NOT EXISTS chat_sessions (
  scope text PRIMARY KEY,
  session_id text NOT NULL,
  updated_at TEXT NOT NULL /* ISO-8601 UTC */
);
