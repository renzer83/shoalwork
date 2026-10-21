-- MCP registry (T-083): the servers a Bot may use, who may use which tools, and the OAuth state of remote ones.
-- Secrets are never stored in clear: env_keys and auth name Vault keys, mcp_oauth holds sealed blobs.
CREATE TABLE IF NOT EXISTS mcp_servers (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  transport text NOT NULL CHECK (transport IN ('stdio', 'http')),
  command text,
  args text NOT NULL DEFAULT '[]' /* JSON array */,
  env_keys text NOT NULL DEFAULT '[]' /* JSON array of Vault keys, injected as env vars of the same name */,
  url text,
  auth text NOT NULL DEFAULT '{"kind":"none"}' /* JSON */,
  enabled integer NOT NULL DEFAULT 1,
  created_at text NOT NULL /* ISO-8601 UTC */
);
CREATE TABLE IF NOT EXISTS bot_mcp (
  bot_id text NOT NULL,
  server_id text NOT NULL REFERENCES mcp_servers (id) ON DELETE CASCADE,
  allowed_tools text NOT NULL DEFAULT '"*"' /* JSON: "*" or an array of tool names */,
  PRIMARY KEY (bot_id, server_id)
);
CREATE INDEX IF NOT EXISTS bot_mcp_server ON bot_mcp (server_id);
CREATE TABLE IF NOT EXISTS mcp_oauth (
  server_id text PRIMARY KEY REFERENCES mcp_servers (id) ON DELETE CASCADE,
  tokens text /* sealed JSON */,
  client_info text /* sealed JSON */,
  code_verifier text /* sealed */,
  state text /* one-time value of the pending authorization; the credential of the callback */,
  state_issued_at text /* ISO-8601 UTC; the state is valid for 10 minutes */,
  auth_url text /* the pending authorization link (public: PKCE challenge only), reused while the state is valid */,
  updated_at text NOT NULL /* ISO-8601 UTC */
);
