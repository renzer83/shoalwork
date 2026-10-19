import { it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { Jobs } from "../src/index.js"
import { nowIso } from "../src/now.js"
import { withTempDb } from "./helpers.js"

const QUEUE = "mail"
const PAST = "2000-01-01T00:00:00.000Z"

const readJob = (id: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const [row] = yield* sql<{
      readonly state: string
      readonly run_at: string
      readonly last_error: string | null
    }>`SELECT state, run_at, last_error FROM jobs WHERE id = ${id}`
    return row
  })

const makeRunnable = (id: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    yield* sql`UPDATE jobs SET run_at = ${PAST} WHERE id = ${id}`
  })

describe("jobs", () => {
  it.effect("enqueue then claim returns the job as active", () =>
    Effect.gen(function* () {
      const queued = yield* Jobs.enqueue(QUEUE, { to: "a@b.c" })
      const claimed = Option.getOrUndefined(yield* Jobs.claim(QUEUE))
      expect(claimed?.id).toBe(queued.id)
      expect(claimed?.state).toBe("active")
      expect(claimed?.attempts).toBe(1)
      expect(claimed?.payload).toBe(JSON.stringify({ to: "a@b.c" }))
    }).pipe(Effect.provide(withTempDb())),
  )

  it.effect("a second claim on an empty queue returns None", () =>
    Effect.gen(function* () {
      yield* Jobs.enqueue(QUEUE, {})
      yield* Jobs.claim(QUEUE)
      const second = yield* Jobs.claim(QUEUE)
      expect(Option.isNone(second)).toBe(true)
    }).pipe(Effect.provide(withTempDb())),
  )

  it.effect("the first failure requeues the job with a future run_at", () =>
    Effect.gen(function* () {
      const job = yield* Jobs.enqueue(QUEUE, {})
      yield* Jobs.claim(QUEUE)
      yield* Jobs.fail(job.id, "boom")
      const row = yield* readJob(job.id)
      expect(row?.state).toBe("queued")
      expect(row?.last_error).toBe("boom")
      expect(row !== undefined && row.run_at > nowIso()).toBe(true)
    }).pipe(Effect.provide(withTempDb())),
  )

  it.effect("the job becomes failed after max_attempts", () =>
    Effect.gen(function* () {
      const job = yield* Jobs.enqueue(QUEUE, {}, { maxAttempts: 2 })
      yield* Jobs.claim(QUEUE)
      yield* Jobs.fail(job.id, "first")
      yield* makeRunnable(job.id)
      yield* Jobs.claim(QUEUE)
      yield* Jobs.fail(job.id, "second")
      const row = yield* readJob(job.id)
      expect(row?.state).toBe("failed")
      expect(row?.last_error).toBe("second")
    }).pipe(Effect.provide(withTempDb())),
  )

  it.effect("reapStale requeues active jobs without a recent heartbeat", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const job = yield* Jobs.enqueue(QUEUE, {})
      yield* Jobs.claim(QUEUE)
      const freshReaped = yield* Jobs.reapStale(60)
      expect(freshReaped).toBe(0)
      yield* sql`UPDATE jobs SET heartbeat_at = ${PAST} WHERE id = ${job.id}`
      const reaped = yield* Jobs.reapStale(60)
      expect(reaped).toBe(1)
      const row = yield* readJob(job.id)
      expect(row?.state).toBe("queued")
    }).pipe(Effect.provide(withTempDb())),
  )

  it.effect("two concurrent claims with two jobs return distinct ids", () =>
    Effect.gen(function* () {
      yield* Jobs.enqueue(QUEUE, { n: 1 })
      yield* Jobs.enqueue(QUEUE, { n: 2 })
      const results = yield* Effect.all([Jobs.claim(QUEUE), Jobs.claim(QUEUE)], { concurrency: 2 })
      const ids = results.map((result) => Option.getOrUndefined(result)?.id)
      expect(ids[0]).toBeDefined()
      expect(ids[1]).toBeDefined()
      expect(ids[0]).not.toBe(ids[1])
    }).pipe(Effect.provide(withTempDb())),
  )
})
