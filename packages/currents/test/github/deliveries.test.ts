import { it } from "@effect/vitest"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { claimDelivery, DELIVERY_WINDOW_MS } from "../../src/github/deliveries.js"

const NOW = new Date("2026-10-20T12:00:00.000Z")
// Each test has its own signatures: the table is shared by the tests of one layer.
const sig = (n: number) => n.toString(16).padStart(64, "0")

describe("claimDelivery", () => {
  it.layer(withTempDb())("X-GitHub-Delivery and signature dedupe", (it) => {
    it.effect("accepts a new delivery once and refuses the repeat inside 24 h", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient
        expect(yield* claimDelivery(sql, "d-1", "push", sig(11), NOW)).toBe(true)
        expect(yield* claimDelivery(sql, "d-1", "push", sig(11), new Date(NOW.getTime() + 60_000))).toBe(
          false,
        )
        expect(yield* claimDelivery(sql, "d-2", "push", sig(12), NOW)).toBe(true)
      }),
    )

    it.effect("a replay with a new delivery id but the same signed body is a duplicate", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient
        expect(yield* claimDelivery(sql, "d-3", "push", sig(21), NOW)).toBe(true)
        expect(yield* claimDelivery(sql, "d-4", "push", sig(21), NOW)).toBe(false)
      }),
    )

    it.effect("accepts an id again once its record is older than the window", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient
        expect(yield* claimDelivery(sql, "d-old", "push", sig(32), NOW)).toBe(true)
        const later = new Date(NOW.getTime() + DELIVERY_WINDOW_MS + 1_000)
        expect(yield* claimDelivery(sql, "d-old", "push", sig(32), later)).toBe(true)
      }),
    )

    it.effect("a claim rolled back with its transaction is not kept", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient
        const failed = yield* sql
          .withTransaction(
            claimDelivery(sql, "d-5", "push", sig(43), NOW).pipe(
              Effect.andThen(Effect.fail("append failed")),
            ),
          )
          .pipe(Effect.flip)
        expect(failed).toBe("append failed")
        expect(yield* claimDelivery(sql, "d-5", "push", sig(43), NOW)).toBe(true)
      }),
    )
  })
})
