import { Effect, Option, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import { nowIso } from "./now.js"
import { JobRow } from "./rows.js"

// Single-writer queue. claim() runs in BEGIN IMMEDIATE (sql.withTransaction on a writable connection).

export interface EnqueueOptions {
  readonly runAt?: Date
  readonly maxAttempts?: number
}

// Rows come from our own schema: a mismatch is a bug, so it is a defect, not a typed error.
const decodeJobs = (rows: ReadonlyArray<unknown>): Effect.Effect<ReadonlyArray<JobRow>> =>
  Schema.decodeUnknownEffect(Schema.Array(JobRow))(rows).pipe(Effect.orDie)

export const enqueue = (
  queue: string,
  payload: unknown,
  opts?: EnqueueOptions,
): Effect.Effect<JobRow, SqlError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const now = nowIso()
    const runAt = opts?.runAt ? opts.runAt.toISOString() : now
    const maxAttempts = opts?.maxAttempts ?? 3
    const rows =
      yield* sql`INSERT INTO jobs (queue, payload, state, attempts, max_attempts, run_at, created_at)
      VALUES (${queue}, ${JSON.stringify(payload)}, 'queued', 0, ${maxAttempts}, ${runAt}, ${now})
      RETURNING *`
    const [job] = yield* decodeJobs(rows)
    if (job === undefined) {
      return yield* Effect.die("INSERT ... RETURNING produced no row")
    }
    return job
  })

export const claim = (queue: string): Effect.Effect<Option.Option<JobRow>, SqlError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const now = nowIso()
    const rows = yield* sql.withTransaction(
      sql`UPDATE jobs SET state = 'active', attempts = attempts + 1, locked_at = ${now}, heartbeat_at = ${now}
        WHERE id = (
          SELECT id FROM jobs
          WHERE queue = ${queue} AND state = 'queued' AND run_at <= ${now}
          ORDER BY run_at, id LIMIT 1
        ) AND state = 'queued'
        RETURNING *`,
    )
    const [job] = yield* decodeJobs(rows)
    return Option.fromNullishOr(job)
  })

// heartbeat/complete/fail return true when this worker still held the lock (a row was changed). `attempt` is the
// `attempts` value returned by claim(): when given, a job that was reaped and claimed again by someone else
// (attempts moved on) no longer counts as ours.

export const heartbeat = (id: number, attempt?: number): Effect.Effect<boolean, SqlError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const guard = attempt ?? null
    const rows = yield* sql`UPDATE jobs SET heartbeat_at = ${nowIso()}
      WHERE id = ${id} AND state = 'active' AND (${guard} IS NULL OR attempts = ${guard})
      RETURNING id`
    return rows.length > 0
  })

export const complete = (id: number, attempt?: number): Effect.Effect<boolean, SqlError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const guard = attempt ?? null
    const rows = yield* sql`UPDATE jobs SET state = 'done', locked_at = NULL, heartbeat_at = NULL
      WHERE id = ${id} AND state = 'active' AND (${guard} IS NULL OR attempts = ${guard})
      RETURNING id`
    return rows.length > 0
  })

// Retry delay is 2^attempts seconds (attempts already counts this claim). Exhausted jobs go to 'failed'.
export const fail = (
  id: number,
  error: string,
  attempt?: number,
): Effect.Effect<boolean, SqlError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const guard = attempt ?? null
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const found = yield* sql<{ readonly attempts: number; readonly max_attempts: number }>`
          SELECT attempts, max_attempts FROM jobs
          WHERE id = ${id} AND state = 'active' AND (${guard} IS NULL OR attempts = ${guard})`
        const job = found[0]
        if (job === undefined) {
          return false
        }
        const exhausted = job.attempts >= job.max_attempts
        const retryAt = new Date(Date.now() + 2 ** job.attempts * 1000).toISOString()
        yield* sql`UPDATE jobs SET state = ${exhausted ? "failed" : "queued"}, run_at = ${retryAt},
          last_error = ${error}, locked_at = NULL, heartbeat_at = NULL WHERE id = ${id}`
        return true
      }),
    )
  })

export interface ReapedJob {
  readonly id: number
  readonly queue: string
  readonly payload: string
}

export interface ReapResult {
  readonly requeued: number
  // Jobs that had already used all their attempts: they are now 'failed' and their owner must be told.
  readonly failed: ReadonlyArray<ReapedJob>
}

// Active jobs without a recent heartbeat go back to the queue; one that already used all its attempts goes to
// 'failed' instead (poison pill: a job that kills its worker must not loop forever). `queue` limits the sweep
// to one queue, so a consumer never fails jobs it cannot report on.
export const reapStale = (
  olderThanSeconds: number,
  queue?: string,
): Effect.Effect<ReapResult, SqlError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const cutoff = new Date(Date.now() - olderThanSeconds * 1000).toISOString()
    const only = queue ?? null
    const rows = yield* sql<{
      readonly id: number
      readonly queue: string
      readonly payload: string
      readonly state: string
    }>`UPDATE jobs SET
        state = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
        last_error = CASE WHEN attempts >= max_attempts THEN 'lock expired after max attempts' ELSE last_error END,
        locked_at = NULL, heartbeat_at = NULL
      WHERE state = 'active' AND (${only} IS NULL OR queue = ${only})
        AND (heartbeat_at IS NULL OR heartbeat_at < ${cutoff})
      RETURNING id, queue, payload, state`
    const failed = rows
      .filter((row) => row.state === "failed")
      .map(({ id, queue: q, payload }) => ({ id, queue: q, payload }))
    return { requeued: rows.length - failed.length, failed }
  })
