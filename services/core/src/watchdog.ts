import type { BeaconShape } from "@shoalwork/beacon"
import { Beacon } from "@shoalwork/beacon"
import { BotRegistry } from "@shoalwork/bots"
import { streamIds, TaskId } from "@shoalwork/contracts"
import { Jobs } from "@shoalwork/db"
import { ApprovalFlow, Control, Lead, TASKS_QUEUE, taskTarget } from "@shoalwork/lead"
import { trackedProcesses } from "@shoalwork/tank"
import { Clock, DateTime, Duration, Effect, Option, Schedule, Schema, Stream } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { decodeRows, guarded, recovered, TaskRow } from "./watchdog-support.js"
import { sweepOrphanWorktrees } from "./watchdog-worktrees.js"

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
const JobRow = Schema.Struct({ id: Schema.Int, attempts: Schema.Int, state: Schema.String })
const JobPayload = Schema.Struct({ taskId: TaskId })
const taskIdOf = (payload: string): Option.Option<TaskId> =>
  Option.flatMap(Option.liftThrowable((text: string): unknown => JSON.parse(text))(payload), (raw) =>
    Option.map(Schema.decodeUnknownOption(JobPayload)(raw), (parsed) => parsed.taskId),
  )

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
    const control = yield* Control
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
        // Interrupts the run when this process still holds it, so the Tank's processes die with it.
        yield* control.stop(taskTarget(task.id), "watchdog")
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

// Pending approvals past their expiry are denied by default (T-054): the task that waits on one is closed blocked.
// A core booted without the approval flow has nothing to expire.
const expireApprovals = () =>
  Effect.gen(function* () {
    const flow = yield* Effect.serviceOption(ApprovalFlow)
    if (Option.isNone(flow)) return 0
    const expired = yield* flow.value.expireDue()
    if (expired > 0) {
      yield* recovered(yield* Beacon, "expired_approval", "approvals", `expired ${expired}`)
    }
    return expired
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
