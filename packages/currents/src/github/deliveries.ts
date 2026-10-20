import { Effect } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"

// A delivery id, or the same signed body, seen inside this window is a repeat.
export const DELIVERY_WINDOW_MS = 24 * 60 * 60 * 1000

// true when the delivery is new and is now recorded; false when its id or its signature was accepted inside the
// window. Expired rows are pruned first. The caller runs this inside its transaction together with the event, so
// a failed append gives the claim back too.
export const claimDelivery = (
  sql: SqlClient,
  deliveryId: string,
  event: string,
  signatureHash: string,
  now: Date,
): Effect.Effect<boolean, SqlError> => {
  const cutoff = new Date(now.getTime() - DELIVERY_WINDOW_MS).toISOString()
  return Effect.gen(function* () {
    yield* sql`DELETE FROM webhook_deliveries WHERE received_at < ${cutoff}`
    const seen = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM webhook_deliveries
      WHERE delivery_id = ${deliveryId} OR signature_hash = ${signatureHash}`
    if ((seen[0]?.n ?? 0) > 0) return false
    yield* sql`INSERT INTO webhook_deliveries (delivery_id, event, signature_hash, received_at)
      VALUES (${deliveryId}, ${event}, ${signatureHash}, ${now.toISOString()})`
    return true
  })
}
