CREATE TABLE IF NOT EXISTS mcp_tokens (
  token_hash text PRIMARY KEY /* sha256 hex of the token; the token itself is never stored */,
  bot_id text NOT NULL,
  repo text NOT NULL,
  task_id text NOT NULL,
  issued_at text NOT NULL /* ISO-8601 UTC */,
  expires_at text NOT NULL /* ISO-8601 UTC */,
  revoked_at text /* ISO-8601 UTC; NULL while the token is usable */
);
CREATE INDEX IF NOT EXISTS mcp_tokens_task ON mcp_tokens (task_id);
