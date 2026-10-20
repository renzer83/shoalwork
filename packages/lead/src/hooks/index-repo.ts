import { Beacon } from "@shoalwork/beacon"
import { BotRegistry } from "@shoalwork/bots"
import {
  BotId,
  type Event,
  EventPayloads,
  newStepId,
  RepoRef,
  repoKeyOf,
  streamIds,
  TaskId,
  type TaskSpec,
} from "@shoalwork/contracts"
import { type JobRow, Jobs } from "@shoalwork/db"
import { Indexer } from "@shoalwork/reef"
import { Tank } from "@shoalwork/tank"
import { Cause, Duration, Effect, Option, Schema, type Scope, Stream } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { TaskStore } from "../tasks.js"
import { clip, describeFailure, EVIDENCE_MAX } from "../verdict.js"

export const INDEX_QUEUE = "index"
// One retry: the queue delivers the job again after a short backoff, then gives up and records error.raised.
const MAX_ATTEMPTS = 2
// Jobs whose heartbeat is older than this are requeued by the reaper (a crashed process).
const REAP_STALE_SECONDS = 120
const REAP_EVERY_MS = 60_000

const TransitionPayload = EventPayloads["task.state_changed"]
const JobPayload = Schema.Struct({ taskId: TaskId, botId: BotId, repo: RepoRef })
type JobPayload = typeof JobPayload.Type

export interface IndexHookOptions {
  readonly pollMs: number
  readonly heartbeatMs: number
}

// Only a code task that names a repo has a repo to index.
export const indexRepoOf = (spec: TaskSpec): RepoRef | undefined =>
  spec.kind === "code" ? spec.repo : undefined

const hasChunks = (sql: SqlClient, repo: string) =>
  Effect.gen(function* () {
    const rows = yield* sql<{
      readonly n: number
    }>`SELECT 1 AS n FROM code_chunks WHERE repo = ${repo} LIMIT 1`
    return rows.length > 0
  })

const logCause = (message: string) => (cause: Cause.Cause<unknown>) =>
  Cause.hasInterruptsOnly(cause)
    ? Effect.interrupt
    : Effect.logError(message, describeFailure(Cause.squash(cause)).tag)

const decodeJob = (text: string): Option.Option<JobPayload> =>
  Option.flatMap(Option.liftThrowable((raw: string): unknown => JSON.parse(raw))(text), (raw) =>
    Schema.decodeUnknownOption(JobPayload)(raw),
  )

// Queues one index job per interesting transition: a code task ending ok (the code it changed is indexed), and a run
// starting on a repo with no indexed chunks yet (the first run of a repo is the one that needs an index). The job
// indexes a fresh worktree of the repo's base branch, so it does not depend on the task's worktree surviving.
// Nothing here changes the task: an indexing failure never turns a task into a failed one.
export const startIndexHook = (
  options: IndexHookOptions,
): Effect.Effect<void, never, Scope.Scope | Beacon | SqlClient | TaskStore | BotRegistry | Tank | Indexer> =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    const tasks = yield* TaskStore
    const bots = yield* BotRegistry
    const tank = yield* Tank
    const indexer = yield* Indexer
    const transitions = yield* beacon.subscribe(["task.state_changed"])

    const queueIfWanted = (event: Event) =>
      Effect.gen(function* () {
        const payload = yield* Schema.decodeUnknownEffect(TransitionPayload)(event.payload).pipe(Effect.orDie)
        if (payload.to !== "done" && payload.to !== "running") {
          return
        }
        const record = yield* tasks.get(payload.taskId)
        const repo = indexRepoOf(record.spec)
        if (repo === undefined) {
          return
        }
        const sql = yield* SqlClient
        if (payload.to === "running" && (yield* hasChunks(sql, repoKeyOf(repo.url)))) {
          return
        }
        yield* Jobs.enqueue(
          INDEX_QUEUE,
          { taskId: payload.taskId, botId: record.spec.botId, repo },
          { maxAttempts: MAX_ATTEMPTS },
        )
      }).pipe(Effect.catchCause(logCause("could not queue indexing")))

    const heartbeat = (job: JobRow) =>
      Effect.forever(
        Effect.sleep(Duration.millis(options.heartbeatMs)).pipe(
          Effect.andThen(Jobs.heartbeat(job.id, job.attempts)),
          Effect.catch((error) => Effect.logWarning("index heartbeat failed", error._tag)),
        ),
      )

    const onFailure = (job: JobRow, payload: JobPayload) => (cause: Cause.Cause<unknown>) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.gen(function* () {
            const failure = describeFailure(Cause.squash(cause))
            const message = clip(`${failure.tag}: ${failure.message}`, EVIDENCE_MAX)
            yield* Jobs.fail(job.id, message, job.attempts)
            if (job.attempts >= job.max_attempts) {
              yield* beacon.append({
                streamId: streamIds.task(payload.taskId),
                type: "error.raised",
                payload: {
                  where: "reef.index",
                  tag: failure.tag,
                  message,
                  taskId: payload.taskId,
                  botId: payload.botId,
                },
                actor: "system:lead",
                correlationId: payload.taskId,
              })
            }
          }).pipe(Effect.catchCause(logCause("could not record the indexing failure")))

    // One fresh worktree of the repo's base branch, indexed, then released: nothing is kept.
    const indexRepo = (payload: JobPayload) =>
      Effect.gen(function* () {
        const bot = yield* bots.get(payload.botId)
        const ctx = yield* tank.prepare(bot, { stepId: newStepId(), repo: payload.repo })
        return yield* indexer
          .index(ctx.cwd, { repoUrl: payload.repo.url })
          .pipe(
            Effect.ensuring(
              tank
                .release(ctx, { keepWorktree: false })
                .pipe(Effect.catch((error) => Effect.logWarning("index release failed", error._tag))),
            ),
          )
      })

    const handle = (job: JobRow) => {
      const parsed = decodeJob(job.payload)
      if (Option.isNone(parsed)) {
        return Jobs.fail(job.id, "invalid job payload", job.attempts).pipe(
          Effect.asVoid,
          Effect.catch((error) => Effect.logWarning("could not fail invalid job", error._tag)),
        )
      }
      const payload = parsed.value
      const work = Effect.gen(function* () {
        const report = yield* indexRepo(payload)
        yield* Effect.logInfo("repo indexed", report.chunks)
        yield* Jobs.complete(job.id, job.attempts)
      }).pipe(Effect.catchCause(onFailure(job, payload)))
      return Effect.raceFirst(work, heartbeat(job)).pipe(
        Effect.annotateLogs({ jobId: job.id, taskId: payload.taskId }),
      )
    }

    const claimStep = Effect.gen(function* () {
      const claimed = yield* Jobs.claim(INDEX_QUEUE)
      if (Option.isNone(claimed)) {
        yield* Effect.sleep(Duration.millis(options.pollMs))
        return
      }
      yield* handle(claimed.value)
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("index claim failed", error._tag).pipe(
          Effect.andThen(Effect.sleep(Duration.millis(options.pollMs))),
        ),
      ),
    )

    const reapStep = Effect.gen(function* () {
      const reaped = yield* Jobs.reapStale(REAP_STALE_SECONDS, INDEX_QUEUE)
      if (reaped.requeued > 0) {
        yield* Effect.logWarning("requeued stale index jobs", reaped.requeued)
      }
      for (const job of reaped.failed) {
        yield* Effect.logWarning("index job abandoned after max attempts", job.id)
      }
      yield* Effect.sleep(Duration.millis(REAP_EVERY_MS))
    }).pipe(Effect.catch((error) => Effect.logWarning("index reap failed", error._tag)))

    yield* Effect.forkScoped(Stream.runForEach(transitions, queueIfWanted))
    yield* Effect.forkScoped(Effect.forever(claimStep))
    yield* Effect.forkScoped(Effect.forever(reapStep))
  })
