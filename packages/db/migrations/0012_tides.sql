-- Tides (T-044): a cron or event trigger that creates a task of a Bot. Only the core writes this table.
CREATE TABLE IF NOT EXISTS tides (
  id text PRIMARY KEY,
  bot_id text NOT NULL REFERENCES bots(id),
  name text NOT NULL,
  kind text NOT NULL /* cron | event */,
  cron_expr text,
  timezone text NOT NULL DEFAULT 'UTC' /* IANA name the cron is evaluated in */,
  event_type text,
  event_filter TEXT /* JSON: { "payload.x": primitive } */,
  task_template TEXT /* JSON */ NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  cooldown_seconds INTEGER NOT NULL DEFAULT 60 /* min seconds between two firings */,
  max_fires_per_hour INTEGER NOT NULL DEFAULT 30 /* rolling-hour firing limit */,
  next_run_at TEXT /* ISO-8601 UTC */,
  last_run_at TEXT /* ISO-8601 UTC */,
  locked_at TEXT /* ISO-8601 UTC: a scheduler's claim on a due cron window */,
  secret text,
  UNIQUE (bot_id, name)
);
CREATE INDEX IF NOT EXISTS tides_due_idx ON tides (kind, enabled, next_run_at);
CREATE INDEX IF NOT EXISTS tides_event_idx ON tides (kind, enabled, event_type);
