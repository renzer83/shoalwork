import { TaskId } from "@shoalwork/contracts"
import { type JobRow, Jobs } from "@shoalwork/db"
import { Duration, Effect, FiberSet, Option, Schema, type Scope, Semaphore } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { TASKS_QUEUE } from "./intake.js"
import type { LeadConfig, RunResult } from "./runner.js"

export interface WorkerDeps {
  readonly sql: SqlClient
  readonly runTask: (id: TaskId) => Effect.Effect<RunResult>
  readonly abandon: (id: TaskId, reason: string) => Effect.Effect<void>
  readonly config: LeadConfig
}

export interface WorkerOptions {
  readonly concurrency: number
  readonly pollMs: number
}

const JobPayload = Schema.Struct({ taskId: TaskId })

const parsePayload = (payload: string): Option.Option<TaskId> =>
  Option.flatMap(Option.liftThrowable((text: string): unknown => JSON.parse(text))(payload), (raw) =>
    Option.map(Schema.decodeUnknownOption(JobPayload)(raw), (parsed) => parsed.taskId),
  )

export const makeWorker = (deps: WorkerDeps) => {
  const { sql, runTask, abandon, config } = deps
  const db = <A, E>(effect: Effect.Effect<A, E, SqlClient>) => Effect.provideService(effect, SqlClient, sql)

  // Resolves with "lost" as soon as a heartbeat finds the lock gone. Transient database errors do not count as lost.
  const watchLock = (job: JobRow): Effect.Effect<"lost"> => {
    const beat = (): Effect.Effect<"lost"> =>
      Effect.sleep(Duration.millis(config.heartbeatMs)).pipe(
        Effect.andThen(
          db(Jobs.heartbeat(job.id, job.attempts)).pipe(
            Effect.catch((error) => Effect.logWarning("heartbeat failed", error._tag).pipe(Effect.as(true))),
          ),
        ),
        Effect.flatMap((held) => (held ? beat() : Effect.succeed("lost" as const))),
      )
    return beat()
  }

  const handleJob = (job: JobRow): Effect.Effect<void> =>
    Effect.gen(function* () {
      const taskId = parsePayload(job.payload)
      if (Option.isNone(taskId)) {
        // Goes through the normal failure path: retried with backoff, 'failed' once attempts run out.
        yield* db(Jobs.fail(job.id, "invalid job payload", job.attempts))
        yield* Effect.logWarning("job with invalid payload failed")
        return
      }
      const outcome = yield* Effect.raceFirst(runTask(taskId.value), watchLock(job))
      if (outcome === "lost") {
        // Another worker owns the job now (or it was reaped): stop touching it.
        yield* Effect.logWarning("lost the job lock, execution abandoned")
        return
      }
      if (!outcome.recorded) {
        // The verdict could not be saved: leave the job active so the reaper hands the task out again.
        yield* Effect.logWarning("verdict not recorded, job left for redelivery")
        return
      }
      // A stopped task is closed for good (failed, no retry); any other verdict completes the job.
      const held = yield* outcome.stopped
        ? db(Jobs.abort(job.id, "stopped", job.attempts))
        : db(Jobs.complete(job.id, job.attempts))
      if (!held) {
        yield* Effect.logWarning("lost the job lock before completing it")
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("job handler crashed", cause).pipe(Effect.andThen(Effect.void)),
      ),
      Effect.annotateLogs({ jobId: job.id }),
    )

  // A job the queue gave up on would leave its task "running" and its Bot "working" forever: close the task.
  const closeReaped = (job: Jobs.ReapedJob): Effect.Effect<void> => {
    const taskId = parsePayload(job.payload)
    return Option.isNone(taskId)
      ? Effect.logWarning("reaped job without a task reference", job.id)
      : abandon(taskId.value, "job lock expired after the maximum number of attempts")
  }

  const reaper: Effect.Effect<never> = Effect.forever(
    db(Jobs.reapStale(config.staleSeconds, TASKS_QUEUE)).pipe(
      Effect.flatMap(({ requeued, failed }) =>
        Effect.gen(function* () {
          if (requeued > 0) {
            yield* Effect.logWarning("requeued stale jobs", requeued)
          }
          yield* Effect.forEach(failed, closeReaped, { discard: true })
        }),
      ),
      Effect.catch((error) => Effect.logWarning("reapStale failed", error._tag)),
      Effect.andThen(Effect.sleep(Duration.millis(config.reapEveryMs))),
    ),
  )

  const startWorker = (opts: WorkerOptions): Effect.Effect<void, never, Scope.Scope> =>
    Effect.gen(function* () {
      const permits = yield* Semaphore.make(Math.max(1, opts.concurrency))
      const running = yield* FiberSet.make()
      const poll = Effect.forever(
        Effect.gen(function* () {
          yield* permits.take(1)
          const claimed = yield* db(Jobs.claim(TASKS_QUEUE, { skipPausedTasks: true })).pipe(
            Effect.catch((error) =>
              Effect.logWarning("claim failed", error._tag).pipe(Effect.as(Option.none<JobRow>())),
            ),
          )
          if (Option.isNone(claimed)) {
            yield* permits.release(1)
            yield* Effect.sleep(Duration.millis(opts.pollMs))
            return
          }
          yield* FiberSet.run(running, handleJob(claimed.value).pipe(Effect.ensuring(permits.release(1))))
        }),
      )
      yield* Effect.forkScoped(reaper)
      yield* Effect.forkScoped(poll)
    })

  return { startWorker }
}
