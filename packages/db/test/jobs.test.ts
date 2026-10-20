import { randomUUID } from "node:crypto"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { makeDbLayer } from "../src/client.js"
import { Jobs, runMigrations } from "../src/index.js"
import { nowIso } from "../src/now.js"
import { withTempDb } from "../src/testing.js"

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
      expect(freshReaped).toEqual({ requeued: 0, requeuedJobs: [], failed: [] })
      yield* sql`UPDATE jobs SET heartbeat_at = ${PAST} WHERE id = ${job.id}`
      const reaped = yield* Jobs.reapStale(60)
      expect(reaped.requeued).toBe(1)
      expect(reaped.requeuedJobs.map((j) => j.id)).toEqual([job.id])
      expect(reaped.failed).toEqual([])
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

  it.effect("reapStale fails a job that already used all its attempts", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const poison = yield* Jobs.enqueue(QUEUE, { n: 1 }, { maxAttempts: 1 })
      const retryable = yield* Jobs.enqueue(QUEUE, { n: 2 }, { maxAttempts: 3 })
      yield* Jobs.claim(QUEUE)
      yield* Jobs.claim(QUEUE)
      yield* sql`UPDATE jobs SET heartbeat_at = ${PAST}`
      const reaped = yield* Jobs.reapStale(60)
      expect(reaped.requeued).toBe(1)
      expect(reaped.failed).toEqual([{ id: poison.id, queue: QUEUE, payload: JSON.stringify({ n: 1 }) }])
      expect((yield* readJob(poison.id))?.state).toBe("failed")
      expect((yield* readJob(retryable.id))?.state).toBe("queued")
      yield* makeRunnable(retryable.id)
      expect(Option.isSome(yield* Jobs.claim(QUEUE))).toBe(true)
      expect(Option.isNone(yield* Jobs.claim(QUEUE))).toBe(true)
    }).pipe(Effect.provide(withTempDb())),
  )

  it.effect("reapStale with a queue only touches that queue", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const mine = yield* Jobs.enqueue(QUEUE, {}, { maxAttempts: 1 })
      const other = yield* Jobs.enqueue("other", {}, { maxAttempts: 1 })
      yield* Jobs.claim(QUEUE)
      yield* Jobs.claim("other")
      yield* sql`UPDATE jobs SET heartbeat_at = ${PAST}`
      const reaped = yield* Jobs.reapStale(60, QUEUE)
      expect(reaped.failed.map((job) => job.id)).toEqual([mine.id])
      expect((yield* readJob(other.id))?.state).toBe("active")
    }).pipe(Effect.provide(withTempDb())),
  )

  it.effect("heartbeat, complete and fail report whether the lock was still held", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const job = yield* Jobs.enqueue(QUEUE, {})
      const claimed = Option.getOrUndefined(yield* Jobs.claim(QUEUE))
      expect(claimed?.attempts).toBe(1)
      expect(yield* Jobs.heartbeat(job.id, 1)).toBe(true)
      // The lock expires and another worker claims the job again (attempts moves on).
      yield* sql`UPDATE jobs SET heartbeat_at = ${PAST}`
      expect((yield* Jobs.reapStale(60)).requeued).toBe(1)
      yield* makeRunnable(job.id)
      const second = Option.getOrUndefined(yield* Jobs.claim(QUEUE))
      expect(second?.attempts).toBe(2)
      // The first worker no longer owns the lock; its calls are no-ops.
      expect(yield* Jobs.heartbeat(job.id, 1)).toBe(false)
      expect(yield* Jobs.fail(job.id, "late", 1)).toBe(false)
      expect(yield* Jobs.complete(job.id, 1)).toBe(false)
      expect((yield* readJob(job.id))?.state).toBe("active")
      expect(yield* Jobs.complete(job.id, 2)).toBe(true)
      expect((yield* readJob(job.id))?.state).toBe("done")
      // Once done, even the current owner's calls report a lost lock.
      expect(yield* Jobs.complete(job.id, 2)).toBe(false)
      expect(yield* Jobs.heartbeat(job.id)).toBe(false)
      expect(yield* Jobs.fail(job.id, "after done")).toBe(false)
    }).pipe(Effect.provide(withTempDb())),
  )

  it.effect("claims from two connections to the same file never return the same job", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = join(tmpdir(), `shoalwork-test-${randomUUID()}.db`)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            for (const suffix of ["", "-wal", "-shm"]) {
              rmSync(`${path}${suffix}`, { force: true })
            }
          }),
        )
        const a = yield* Layer.build(makeDbLayer(path))
        const b = yield* Layer.build(makeDbLayer(path))
        yield* runMigrations.pipe(Effect.provide(a))
        for (let n = 0; n < 6; n++) {
          yield* Jobs.enqueue(QUEUE, { n }).pipe(Effect.provide(a))
        }
        const claimAll = (ctx: typeof a) =>
          Effect.gen(function* () {
            const ids: Array<number> = []
            for (let n = 0; n < 6; n++) {
              const job = Option.getOrUndefined(yield* Jobs.claim(QUEUE))
              if (job !== undefined) {
                ids.push(job.id)
              }
              yield* Effect.yieldNow
            }
            return ids
          }).pipe(Effect.provide(ctx))
        const [fromA, fromB] = yield* Effect.all([claimAll(a), claimAll(b)], { concurrency: 2 })
        const all = [...fromA, ...fromB]
        expect(all).toHaveLength(6)
        expect(new Set(all).size).toBe(6)
      }),
    ),
  )
})
