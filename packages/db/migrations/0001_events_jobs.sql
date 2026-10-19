CREATE TABLE IF NOT EXISTS events (
  position INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  stream_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  actor TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  occurred_at TEXT NOT NULL,
  UNIQUE (stream_id, version)
);
CREATE INDEX IF NOT EXISTS events_type_idx ON events (type, occurred_at);
CREATE INDEX IF NOT EXISTS events_corr_idx ON events (correlation_id);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  queue TEXT NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_at TEXT NOT NULL,
  locked_at TEXT,
  heartbeat_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs (queue, state, run_at);
