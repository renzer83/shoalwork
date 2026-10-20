CREATE TABLE IF NOT EXISTS bots (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  definition TEXT /* JSON */ NOT NULL,
  state text NOT NULL DEFAULT 'idle',
  source_path text,
  updated_at TEXT NOT NULL /* ISO-8601 UTC */
);
