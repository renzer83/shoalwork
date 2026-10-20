-- GitHub webhook deliveries the core has accepted (T-045). A repeat of the delivery id, or of the same signed body
-- (signature_hash = sha256 of X-Hub-Signature-256), inside 24 h is ignored.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id text PRIMARY KEY,
  event text NOT NULL,
  signature_hash text NOT NULL,
  received_at text NOT NULL /* ISO-8601 UTC */
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_received_idx ON webhook_deliveries (received_at);
CREATE INDEX IF NOT EXISTS webhook_deliveries_signature_idx ON webhook_deliveries (signature_hash);
