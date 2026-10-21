-- Context ranking (T-096): commit time cache per file, chunk outcome history and tuned weights.
ALTER TABLE code_chunks ADD COLUMN last_commit_at TEXT /* ISO-8601 UTC of the last commit touching the file */;
CREATE TABLE IF NOT EXISTS chunk_success (repo TEXT NOT NULL, chunk_id TEXT NOT NULL, ok INTEGER NOT NULL DEFAULT 0, fail INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo, chunk_id));
CREATE TABLE IF NOT EXISTS rank_weights (name TEXT PRIMARY KEY, weights TEXT NOT NULL /* JSON */, updated_at TEXT NOT NULL /* ISO-8601 UTC */);
-- Cron windows of jobs that belong to the system, not to a Bot (rank-tune): one row per job, claimed with locked_at.
CREATE TABLE IF NOT EXISTS system_tides (name TEXT PRIMARY KEY, next_run_at TEXT NOT NULL /* ISO-8601 UTC */, locked_at TEXT);
