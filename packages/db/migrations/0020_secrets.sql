-- Vault secrets (T-064): one row per (key, scope, bot_id). A Bot reads a secret of its own scope or a
-- shared global; `backend_ref` names where the value lives (env:, file:, op://). Values are never stored here.
CREATE TABLE IF NOT EXISTS secrets (
  key text NOT NULL,
  scope text NOT NULL /* bot | global */,
  bot_id text NOT NULL DEFAULT '' /* '' = global */,
  backend_ref text NOT NULL,
  shared integer NOT NULL DEFAULT 0 /* 1 = any Bot may read this global */,
  PRIMARY KEY (key, scope, bot_id)
);
