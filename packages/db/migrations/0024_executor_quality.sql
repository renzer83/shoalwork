-- Executor quality per task kind and window (T-074): recomputed hourly by the core from executor.finished and
-- usage.recorded, one row per (executor, kind, window). The routing of the Reflex reads it; nothing else writes it.
CREATE TABLE IF NOT EXISTS executor_quality (
  executor text NOT NULL,
  kind text NOT NULL,
  window_days integer NOT NULL /* 7 or 30 */,
  n integer NOT NULL,
  ok_rate real NOT NULL,
  retry_rate real NOT NULL,
  avg_usd real NOT NULL,
  avg_seconds real NOT NULL,
  computed_at text NOT NULL /* ISO-8601 UTC */,
  PRIMARY KEY (executor, kind, window_days)
);
