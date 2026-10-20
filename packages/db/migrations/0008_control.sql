CREATE TABLE IF NOT EXISTS control_flags (
  scope text PRIMARY KEY /* 'global' | 'bot:<id>' */,
  paused INTEGER NOT NULL DEFAULT 0 /* 0|1 */,
  updated_at TEXT NOT NULL /* ISO-8601 UTC */
);
