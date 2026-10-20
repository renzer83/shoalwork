import { it } from "@effect/vitest"
import { BeaconTest } from "@shoalwork/beacon"
import { BotId, newTaskId } from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { APPROVAL_TTL_MS, Approvals, ApprovalsLive } from "@shoalwork/policy"
import { Duration, Effect, Fiber, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { describe, expect } from "vitest"
import { MAX_WAIT_MS, parseTimeout, waitForDecision } from "../src/http/routes/policy.js"

const BOT = Schema.decodeUnknownSync(BotId)("bot_3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41")
const layer = ApprovalsLive.pipe(Layer.provideMerge(BeaconTest), Layer.provideMerge(withTempDb()))

const pendingApproval = Effect.gen(function* () {
  const sql = yield* SqlClient
  const taskId = newTaskId()
  const now = new Date(0).toISOString()
  yield* sql`INSERT OR IGNORE INTO bots (id, name, definition, state, updated_at)
    VALUES (${BOT}, 'waiter', '{}', 'idle', ${now})`
  yield* sql`INSERT INTO tasks (id, bot_id, spec, state, created_at, updated_at)
    VALUES (${taskId}, ${BOT}, '{}', 'working', ${now}, ${now})`
  const approvals = yield* Approvals
  return yield* approvals.request({
    taskId,
    botId: BOT,
    action: { tool: "Bash", input: { command: "git push" } },
    risk: "external",
  })
})

describe("waitForDecision (test clock)", () => {
  it.effect("returns pending exactly when the slice ends, never earlier", () =>
    Effect.gen(function* () {
      const approval = yield* pendingApproval
      const fiber = yield* Effect.forkChild(waitForDecision(approval.id, MAX_WAIT_MS))
      yield* TestClock.adjust(Duration.millis(MAX_WAIT_MS - 1))
      expect(fiber.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust(Duration.millis(1))
      expect(yield* Fiber.join(fiber)).toBe("pending")
    }).pipe(Effect.provide(layer)),
  )

  it.effect("returns as soon as the approval is decided", () =>
    Effect.gen(function* () {
      const approval = yield* pendingApproval
      const approvals = yield* Approvals
      const fiber = yield* Effect.forkChild(waitForDecision(approval.id, MAX_WAIT_MS))
      yield* TestClock.adjust(Duration.millis(5_000))
      yield* approvals.resolve(approval.id, "denied", "user:cli")
      yield* TestClock.adjust(Duration.millis(1_000))
      expect(yield* Fiber.join(fiber)).toBe("denied")
      expect(yield* TestClock.adjust(Duration.millis(0)).pipe(Effect.as("settled"))).toBe("settled")
    }).pipe(Effect.provide(layer)),
  )

  it.effect("reads a pending request past its expiry as expired, without writing it", () =>
    Effect.gen(function* () {
      const approval = yield* pendingApproval
      const approvals = yield* Approvals
      yield* TestClock.adjust(Duration.millis(APPROVAL_TTL_MS))
      expect(yield* waitForDecision(approval.id, MAX_WAIT_MS)).toBe("expired")
      expect((yield* approvals.get(approval.id)).status).toBe("pending")
    }).pipe(Effect.provide(layer)),
  )
})

describe("parseTimeout", () => {
  it.effect("defaults to and caps at 60 s, and refuses what is not a positive integer", () =>
    Effect.gen(function* () {
      expect(yield* parseTimeout(undefined)).toBe(MAX_WAIT_MS)
      expect(yield* parseTimeout("5000")).toBe(5000)
      expect(yield* parseTimeout("999999")).toBe(MAX_WAIT_MS)
      for (const bad of ["0", "-1", "1.5", "abc", ""]) {
        expect((yield* Effect.flip(parseTimeout(bad)))._tag).toBe("SchemaViolation")
      }
    }),
  )
})
