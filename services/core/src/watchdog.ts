import type { BeaconShape } from "@shoalwork/beacon"
import { Beacon } from "@shoalwork/beacon"
import { BotRegistry } from "@shoalwork/bots"
import { type Bot, BotId, streamIds, TaskId } from "@shoalwork/contracts"
import { Jobs } from "@shoalwork/db"
import { Lead, stepIdFor, TASKS_QUEUE } from "@shoalwork/lead"
import { Tank, trackedProcesses } from "@shoalwork/tank"
import { Cause, Clock, DateTime, Duration, Effect, Option, Schedule, Schema, Stream } from "effect"
import { SqlClient } from "effect/sql/SqlClient"

// Recovery loop: every cycle runs each check on its own, so one failing check never stops the others. Every action
// it takes is a watchdog.recovered on the system stream; a failed check is an error.raised there.

export interface WatchdogConfig {
  readonly intervalMs: number
  // A running task with no event for longer than this is stale.
  readonly staleMinutes: number
  // A Tank process alive for longer than this is killed.
  readonly maxProcessMinutes: number
}

// A stale task gets one more attempt through the queue while it has used fewer than this many.
const MAX_STALE_ATTEMPTS = 2
const REAP_SECONDS = 120
const WORKTREE_TTL_MS = 24 * 60 * 60 * 1000
const ACTOR = "system:watchdog"
const CORRELATION = "watchdog"

const TaskRow = Schema.Struct({
  id: TaskId,
  bot_id: BotId,
  attempts: Schema.Int,
  state: Schema.String,
  spec: Schema.String,
  updated_at: Schema.String,
})

const JobRow = Schema.Struct({ id: Schema.Int, attempts: Schema.Int, state: Schema.String })
const JobPayload = Schema.Struct({ taskId: TaskId })
const RepoSpec = Schema.Struct({ repo: Schema.optional(Schema.Struct({ url: Schema.String })) })

const decodeRows = <A, I>(schema: Schema.Codec<A, I>, rows: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(schema))(rows).pipe(Effect.orDie)

const taskIdOf = (payload: string): Option.Option<TaskId> =>
  Option.flatMap(Option.liftThrowable((text: string): unknown => JSON.parse(text))(payload), (raw) =>
    Option.map(Schema.decodeUnknownOption(JobPayload)(raw), (parsed) => parsed.taskId),
  )

const describe = (failure: unknown): { readonly tag: string; readonly message: string } => {
  if (failure instanceof Error) return { tag: failure.name, message: failure.message }
  if (
    typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    typeof failure._tag === "string"
  ) {
    return { tag: failure._tag, message: failure._tag }
  }
  return { tag: "Defect", message: String(failure) }
}

// Reporting a failure must not hide the failure being reported.
const reportError = (where: string, failure: unknown): Effect.Effect<void, never, Beacon> =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    const { tag, message } = describe(failure)
    yield* beacon
      .append({
        streamId: streamIds.system,
        type: "error.raised",
        payload: { where: `watchdog.${where}`, tag, message },
        actor: ACTOR,
        correlationId: CORRELATION,
      })
      .pipe(Effect.catchCause(() => Effect.void))
  })

// One check: its failure becomes error.raised and a count of zero. Interruption is never swallowed.
const guarded = <R>(
  where: string,
  check: Effect.Effect<number, unknown, R>,
): Effect.Effect<number, never, R | Beacon> =>
  check.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : reportError(where, Cause.squash(cause)).pipe(Effect.as(0)),
    ),
  )

const recovered = (
  beacon: BeaconShape,
  what:
    | "stale_task"
    | "stale_job"
    | "long_process"
    | "expired_approval"
    | "state_mismatch"
    | "orphan_worktree",
  ref: string,
  action: string,
) =>
  beacon.append({
    streamId: streamIds.system,
    type: "watchdog.recovered",
    payload: { what, ref, action },
    actor: ACTOR,
    correlationId: CORRELATION,
  })

// Epoch ms of the task's last event (its stream); the row's updated_at when the stream is empty.
const lastActivityMs = (beacon: BeaconShape, taskId: TaskId, fallbackIso: string) =>
  Effect.gen(function* () {
    const streamId = streamIds.task(taskId)
    const version = yield* beacon.lastVersion(streamId)
    const fallback = Date.parse(fallbackIso)
    if (version === 0) return fallback
    const last = yield* Stream.runLast(beacon.readStream(streamId, version - 1))
    return Option.match(last, {
      onNone: () => fallback,
      onSome: (event) => DateTime.toEpochMillis(event.occurredAt),
    })
  })

// The newest job of a task (the queue keeps one per task; the latest one is the one that counts).
const latestJob = (taskId: TaskId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const rows = yield* sql`SELECT id, attempts, state FROM jobs
      WHERE queue = ${TASKS_QUEUE} AND json_extract(payload, '$.taskId') = ${taskId}
      ORDER BY id DESC LIMIT 1`
    const [job] = yield* decodeRows(JobRow, rows)
    return Option.fromNullishOr(job)
  })

// Running tasks with no event for longer than the stale limit: stopped, or requeued while they have attempts left.
const recoverStaleTasks = (config: WatchdogConfig) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const beacon = yield* Beacon
    const lead = yield* Lead
    const now = yield* Clock.currentTimeMillis
    const staleMs = config.staleMinutes * 60_000
    const rows =
      yield* sql`SELECT id, bot_id, attempts, state, spec, updated_at FROM tasks WHERE state = 'running'`
    const running = yield* decodeRows(TaskRow, rows)
    let count = 0
    for (const task of running) {
      const activity = yield* lastActivityMs(beacon, task.id, task.updated_at)
      if (now - activity <= staleMs) continue
      const job = yield* latestJob(task.id)
      // Still waiting in the queue: the next claim runs it, nothing is stuck.
      if (Option.isSome(job) && job.value.state === "queued") continue
      const active = Option.isSome(job) && job.value.state === "active"
      if (active && task.attempts < MAX_STALE_ATTEMPTS) {
        // The worker sees its lock gone at the next heartbeat and stops the run; the queue delivers the task again.
        yield* Jobs.fail(job.value.id, "stale", job.value.attempts)
        yield* recovered(beacon, "stale_task", task.id, "requeued")
      } else {
        yield* lead.abandon(task.id, "watchdog: stale")
        if (active) {
          yield* Jobs.fail(job.value.id, "stale", job.value.attempts)
        }
        yield* recovered(beacon, "stale_task", task.id, "stopped")
      }
      count++
    }
    return count
  })

// Active jobs without a heartbeat go back to the queue; the ones out of attempts close their task.
// Every job reaped is recorded as stale_job (action requeued | failed).
const reapJobs = () =>
  Effect.gen(function* () {
    const lead = yield* Lead
    const beacon = yield* Beacon
    const { requeuedJobs, failed } = yield* Jobs.reapStale(REAP_SECONDS, TASKS_QUEUE)
    for (const job of requeuedJobs) {
      yield* recovered(beacon, "stale_job", `job:${job.id}`, "requeued")
    }
    for (const job of failed) {
      yield* recovered(beacon, "stale_job", `job:${job.id}`, "failed")
      const taskId = taskIdOf(job.payload)
      if (Option.isSome(taskId)) {
        yield* lead.abandon(taskId.value, "job lock expired after the maximum number of attempts")
      }
    }
    return requeuedJobs.length + failed.length
  })

// Tank processes alive for longer than the limit: process group killed, then recorded.
const killLongProcesses = (config: WatchdogConfig) =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    const now = yield* Clock.currentTimeMillis
    const limitMs = config.maxProcessMinutes * 60_000
    let count = 0
    for (const proc of trackedProcesses()) {
      if (now - proc.startedAt <= limitMs) continue
      yield* proc.terminate
      yield* recovered(beacon, "long_process", `pid:${proc.pid}`, "killed")
      count++
    }
    return count
  })

// Approvals arrive with T-054. Until its table exists there is nothing to expire.
const expireApprovals = () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const rows = yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'approvals'`
    if (rows.length > 0) {
      return yield* Effect.die("approvals table exists: the expiry sweep is defined by T-054")
    }
    return 0
  })

// Bots marked working with no running task go idle; jobs active on a task that already settled are completed.
const reconcile = (config: WatchdogConfig) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const beacon = yield* Beacon
    const bots = yield* BotRegistry
    const now = yield* Clock.currentTimeMillis
    let count = 0
    const runningRows = yield* sql`SELECT DISTINCT bot_id FROM tasks WHERE state = 'running'`
    const runningBots = new Set(runningRows.map((row) => String(row.bot_id)))
    for (const bot of yield* bots.list()) {
      if (bot.state !== "working" || runningBots.has(bot.id)) continue
      yield* bots.setState(bot.id, "idle")
      yield* recovered(beacon, "state_mismatch", `bot:${bot.id}`, "idle")
      count++
    }
    // Only tasks that settled a while ago: a worker that is still finishing its own job is left alone.
    const cutoff = new Date(now - config.staleMinutes * 60_000).toISOString()
    const stuck = yield* sql`SELECT j.id AS job_id, j.attempts AS attempts, t.id AS task_id
      FROM jobs j JOIN tasks t ON t.id = json_extract(j.payload, '$.taskId')
      WHERE j.queue = ${TASKS_QUEUE} AND j.state = 'active'
        AND t.state IN ('done', 'failed') AND t.updated_at < ${cutoff}`
    for (const row of stuck) {
      const jobId = Number(row.job_id)
      const attempts = Number(row.attempts)
      yield* Jobs.complete(jobId, attempts)
      yield* recovered(beacon, "state_mismatch", String(row.task_id), "job completed")
      count++
    }
    return count
  })

interface WorktreeGroup {
  readonly bot: Bot
  readonly repoUrl: string
  // Branch of every step a task may have used (one per attempt) -> the task.
  readonly branches: Map<string, TaskId>
}

// Worktrees of terminal tasks older than a day are removed (T-031 debt). Running tasks are never touched.
const sweepOrphanWorktrees = () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const beacon = yield* Beacon
    const bots = yield* BotRegistry
    const tank = yield* Tank
    const now = yield* Clock.currentTimeMillis
    const cutoff = new Date(now - WORKTREE_TTL_MS).toISOString()
    const rows = yield* sql`SELECT id, bot_id, attempts, state, spec, updated_at FROM tasks
      WHERE state IN ('done', 'failed', 'cancelled') AND updated_at < ${cutoff}`
    const groups = new Map<string, WorktreeGroup>()
    for (const row of yield* decodeRows(TaskRow, rows)) {
      const repo = yield* Effect.try({
        try: (): unknown => JSON.parse(row.spec),
        catch: (cause) => cause,
      }).pipe(
        Effect.flatMap((raw) => Schema.decodeUnknownEffect(RepoSpec)(raw)),
        Effect.option,
        Effect.map((parsed) => (Option.isSome(parsed) ? parsed.value.repo : undefined)),
      )
      if (repo === undefined) continue
      const bot = yield* bots.get(row.bot_id).pipe(Effect.option)
      if (Option.isNone(bot)) continue
      const key = `${row.bot_id}\n${repo.url}`
      const group = groups.get(key) ?? {
        bot: bot.value,
        repoUrl: repo.url,
        branches: new Map<string, TaskId>(),
      }
      for (let attempt = 1; attempt <= row.attempts + 1; attempt++) {
        group.branches.set(`bot/${bot.value.name}/${stepIdFor(row.id, attempt)}`, row.id)
      }
      groups.set(key, group)
    }
    let count = 0
    for (const group of groups.values()) {
      const removed = yield* guarded(
        "orphan_worktrees",
        Effect.gen(function* () {
          let done = 0
          for (const wt of yield* tank.worktrees(group.bot, group.repoUrl)) {
            if (!group.branches.has(wt.branch)) continue
            done += yield* guarded(
              "orphan_worktrees",
              tank
                .removeWorktree(group.bot, wt)
                .pipe(
                  Effect.andThen(recovered(beacon, "orphan_worktree", wt.branch, "removed")),
                  Effect.as(1),
                ),
            )
          }
          return done
        }),
      )
      count += removed
    }
    return count
  })

// One pass over every check, in the order of 02-architecture §11. Resolves when all of them ran.
export const runWatchdogCycle = (config: WatchdogConfig) =>
  Effect.gen(function* () {
    const results = [
      yield* guarded("stale_tasks", recoverStaleTasks(config)),
      yield* guarded("reap_jobs", reapJobs()),
      yield* guarded("long_processes", killLongProcesses(config)),
      yield* guarded("expired_approvals", expireApprovals()),
      yield* guarded("reconcile", reconcile(config)),
      yield* guarded("orphan_worktrees", sweepOrphanWorktrees()),
    ]
    const total = results.reduce((sum, n) => sum + n, 0)
    if (total > 0) {
      yield* Effect.logInfo("watchdog recovered", {
        staleTasks: results[0],
        reapedJobs: results[1],
        longProcesses: results[2],
        expiredApprovals: results[3],
        reconciled: results[4],
        orphanWorktrees: results[5],
      })
    }
  })

// Forked in the caller's scope: the loop stops when that scope closes. The first cycle runs at once.
export const startWatchdog = (config: WatchdogConfig) =>
  Effect.forkScoped(
    Effect.repeat(runWatchdogCycle(config), Schedule.spaced(Duration.millis(config.intervalMs))).pipe(
      Effect.asVoid,
    ),
  )
