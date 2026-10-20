CREATE TABLE IF NOT EXISTS bot_proposals (
  id text PRIMARY KEY,
  requested_by text NOT NULL,
  proposal TEXT /* JSON: the NewBot proposed by the model, validated before storage */ NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'cancelled', 'expired', 'failed')),
  created_at TEXT NOT NULL /* ISO-8601 UTC */,
  expires_at TEXT NOT NULL /* ISO-8601 UTC */,
  decided_at TEXT /* ISO-8601 UTC */,
  message_chat_id text /* Telegram chat of the proposal message (its buttons are removed on decision) */,
  message_id INTEGER /* Telegram message id of the proposal message */
);
