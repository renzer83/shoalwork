-- Approvals (T-054): one row per ask decision of the policy. `action` is the bounded, redacted ToolCall (JSON).
-- chat_id / thread_id / message_id locate the Telegram card, so its buttons can be removed once the approval is decided.
CREATE TABLE IF NOT EXISTS approvals (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id),
  bot_id text NOT NULL REFERENCES bots(id),
  step_id text,
  session_id text,
  action TEXT /* JSON */ NOT NULL,
  action_hash text /* sha256 of tool + canonical input, before redaction */ NOT NULL,
  risk text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  requested_at TEXT NOT NULL /* ISO-8601 UTC */,
  expires_at TEXT NOT NULL /* ISO-8601 UTC */,
  resolved_at TEXT /* ISO-8601 UTC */,
  resolved_by text,
  consumed_at TEXT /* ISO-8601 UTC: the run that followed the decision started; a decision is used once */,
  chat_id text,
  thread_id INTEGER,
  message_id INTEGER
);
CREATE INDEX IF NOT EXISTS approvals_status_expires_idx ON approvals (status, expires_at);
-- One open request per task: the task is paused on exactly one approval.
CREATE UNIQUE INDEX IF NOT EXISTS approvals_one_pending_idx ON approvals (task_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS approvals_task_idx ON approvals (task_id, requested_at);
