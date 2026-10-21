-- Summaries of context blocks that the Lead shortened to fit the budget (T-097). `hash` is sha256 of the level and the text
-- summarized, so one text has one summary per level. Rows older than cache_ttl_hours (config/context.yaml) are ignored on
-- read, not deleted. Only the Lead writes it.
CREATE TABLE IF NOT EXISTS context_summaries (
  hash text NOT NULL PRIMARY KEY,
  level integer NOT NULL CHECK (level IN (2, 3)),
  summary text NOT NULL,
  tokens integer NOT NULL,
  created_at text NOT NULL /* ISO-8601 UTC */
);
