-- Permission bridge (T-177). An approval is "inline" when the CLI is blocked on the tool call waiting for the answer
-- (nothing is resumed afterwards), "resume" when the run ended and the Lead continues the session (T-054).
ALTER TABLE approvals ADD COLUMN mode text NOT NULL DEFAULT 'resume' CHECK (mode IN ('inline', 'resume'));
-- The run's worktree and the bridge mode, bound to its execution token once the Tank context exists. NULL: no bridge.
ALTER TABLE mcp_tokens ADD COLUMN cwd text;
ALTER TABLE mcp_tokens ADD COLUMN bridge_mode text CHECK (bridge_mode IS NULL OR bridge_mode IN ('inline', 'resume'));
