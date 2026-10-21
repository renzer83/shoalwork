-- Subscription quota per executor and window (T-075). One row per (executor, window kind, window start); a window opens
-- on the first usage after the previous one closed. Tokens are tokensIn + tokensOut; usd is the CLI-reported cost.
CREATE TABLE IF NOT EXISTS executor_quota (
  executor TEXT NOT NULL,
  window_kind TEXT NOT NULL /* "5h" | "7d" | "custom" */,
  window_start TEXT NOT NULL /* ISO-8601 UTC */,
  window_end TEXT NOT NULL /* ISO-8601 UTC */,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  usd_used REAL NOT NULL DEFAULT 0,
  exhausted_at TEXT /* ISO-8601 UTC; the executor reported its limit, or it was set by hand */,
  source TEXT /* "usage" | "429" | "limit_text" | "manual" */,
  PRIMARY KEY (executor, window_kind, window_start)
);
