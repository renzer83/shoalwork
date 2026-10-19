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

export const heartbeat = (id: number): Effect.Effect<void, SqlError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    yield* sql`UPDATE jobs SET heartbeat_at = ${nowIso()} WHERE id = ${id} AND state = 'active'`
  })

export const complete = (id: number): Effect.Effect<void, SqlError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    yield* sql`UPDATE jobs SET state = 'done', locked_at = NULL, heartbeat_at = NULL WHERE id = ${id} AND state = 'active'`
  })

// Retry delay is 2^attempts seconds (attempts already counts this claim). Exhausted jobs go to 'failed'.
export const fail = (id: number, error: string): Effect.Effect<void, SqlError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const found = yield* sql<{ readonly attempts: number; readonly max_attempts: number }>`
          SELECT attempts, max_attempts FROM jobs WHERE id = ${id} AND state = 'active'`
        const job = found[0]
        if (job === undefined) {
          return
        }
        const exhausted = job.attempts >= job.max_attempts
        const retryAt = new Date(Date.now() + 2 ** job.attempts * 1000).toISOString()
        yield* sql`UPDATE jobs SET state = ${exhausted ? "failed" : "queued"}, run_at = ${retryAt},
          last_error = ${error}, locked_at = NULL, heartbeat_at = NULL WHERE id = ${id}`
      }),
    )
  })

// Returns how many active jobs without a recent heartbeat were put back in the queue.
export const reapStale = (olderThanSeconds: number): Effect.Effect<number, SqlError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const cutoff = new Date(Date.now() - olderThanSeconds * 1000).toISOString()
    const rows = yield* sql`UPDATE jobs SET state = 'queued', locked_at = NULL, heartbeat_at = NULL
      WHERE state = 'active' AND (heartbeat_at IS NULL OR heartbeat_at < ${cutoff})
      RETURNING id`
    return rows.length
  })
