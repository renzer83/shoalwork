import type { BeaconShape } from "@shoalwork/beacon"
import { Beacon } from "@shoalwork/beacon"
import { BotRegistry } from "@shoalwork/bots"
import { type SessionId, type StepId, streamIds, TaskId, ZERO_USAGE } from "@shoalwork/contracts"
import { Jobs } from "@shoalwork/db"
import {
  ApprovalFlow,
  Control,
  Lead,
  resumeAfterRestart,
  stepIdFor,
  TASKS_QUEUE,
  taskTarget,
} from "@shoalwork/lead"
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

// Tasks found in `running` with no job queued or active lost their worker to a restart (the orchestrator came back
// before `staleMinutes` elapsed). Each one is put back on the queue right away so the next worker picks it up and
// `recoveredCarry` continues the same step (same worktree, same session when the Tank still has them). Running the
// query again is a no-op: a task that already has a queued or active job is skipped. `resumeAfterRestart` builds a
// typed carry for the log so the resume is auditable alongside the recovered event.
const RunningRow = Schema.Struct({
  id: TaskId,
  attempts: Schema.Int,
  session_id: Schema.NullOr(Schema.String),
})

const reconcileRunningAfterRestart = () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const beacon = yield* Beacon
    const rows = yield* sql`
      SELECT t.id AS id, t.attempts AS attempts, t.session_id AS session_id FROM tasks t
      WHERE t.state = 'running'
        AND NOT EXISTS (
          SELECT 1 FROM jobs j
          WHERE j.queue = ${TASKS_QUEUE}
            AND json_extract(j.payload, '$.taskId') = t.id
            AND j.state IN ('queued', 'active')
        )`
    const pending = yield* decodeRows(RunningRow, rows)
    let count = 0
    for (const task of pending) {
      const attempts = Math.max(1, task.attempts)
      const stepId: StepId = stepIdFor(task.id, attempts)
      const sessionId: SessionId | undefined =
        task.session_id === null || task.session_id === "" ? undefined : (task.session_id as SessionId)
      // Pure carry used for logging the planned resume; the worker builds its own on claim.
      const carry = resumeAfterRestart({
        stepId,
        worktree: undefined,
        sessionId,
        usage: ZERO_USAGE,
      })
      yield* Effect.logInfo("watchdog: resuming task after restart", {
        taskId: task.id,
        stepId: carry.stepId,
        sessionId: carry.sessionId ?? null,
      })
      yield* Jobs.enqueue(TASKS_QUEUE, { taskId: task.id })
      yield* recovered(beacon, "stale_task", task.id, "restart_resume")
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

// Time a Tank process spent with its run blocked on an inline approval (T-177): the CLI is alive and idle on purpose
// until the person answers, so that time is not part of its age. The process is matched by its pid (the group the Lead
// recorded for the run), and only the waits that began after it started count. A pending request counts up to now
// or its expiry.
const inlineWaitsByPid = (nowMs: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const rows = yield* sql`SELECT p.pgid AS pid, a.requested_at, a.resolved_at, a.expires_at
      FROM task_processes p JOIN approvals a ON a.task_id = p.task_id AND a.mode = 'inline'`
    return (proc: { readonly pid: number; readonly startedAt: number }): number =>
      rows.reduce((total, row) => {
        const requested = Date.parse(String(row.requested_at))
        if (Number(row.pid) !== proc.pid || requested < proc.startedAt) return total
        const end =
          row.resolved_at === null
            ? Math.min(nowMs, Date.parse(String(row.expires_at)))
            : Date.parse(String(row.resolved_at))
        return total + Math.max(0, end - requested)
      }, 0)
  })

// Tank processes alive for longer than the limit: process group killed, then recorded.
const killLongProcesses = (config: WatchdogConfig) =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    const now = yield* Clock.currentTimeMillis
    const limitMs = config.maxProcessMinutes * 60_000
    const waited = yield* inlineWaitsByPid(now)
    let count = 0
    for (const proc of trackedProcesses()) {
      if (now - proc.startedAt - waited(proc) <= limitMs) continue
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
    // A task blocked on an inline approval is waiting_approval but its Bot is still working (T-177).
    const runningRows = yield* sql`SELECT DISTINCT bot_id FROM tasks WHERE state = 'running'
      OR (state = 'waiting_approval' AND id IN (SELECT task_id FROM approvals WHERE status = 'pending' AND mode = 'inline'))`
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
      yield* guarded("restart_resume", reconcileRunningAfterRestart()),
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
        restartResumed: results[0],
        staleTasks: results[1],
        reapedJobs: results[2],
        longProcesses: results[3],
        expiredApprovals: results[4],
        reconciled: results[5],
        orphanWorktrees: results[6],
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
