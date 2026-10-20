CREATE TABLE IF NOT EXISTS telegram_topics (
  bot_id text PRIMARY KEY,
  chat_id text NOT NULL,
  thread_id INTEGER NOT NULL,
  created_at TEXT NOT NULL /* ISO-8601 UTC */
);
CREATE UNIQUE INDEX IF NOT EXISTS telegram_topics_thread_idx ON telegram_topics (chat_id, thread_id);
