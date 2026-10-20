import type { BeaconShape } from "@shoalwork/beacon"
import type { BotRegistryShape } from "@shoalwork/bots"
import {
  type BotId,
  type BotState,
  type NotFound,
  streamIds,
  type TaskId,
  TaskId as TaskIdSchema,
} from "@shoalwork/contracts"
import { Context, Deferred, Duration, Effect, Option, Schema, type Scope } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import { botScope, GLOBAL_SCOPE, makeControlFlags, scopeOf } from "./control-flags.js"
import { closeJobsOf, makeRecovery, type RecoveryReport } from "./control-recovery.js"
import { makeLifecycle } from "./lifecycle.js"
import { emit, type TaskStoreShape } from "./tasks.js"
import { INITIAL, stoppedVerdict } from "./verdict.js"

// Pause, resume and stop at three levels: everything, one Bot, one task. A pause only stops new work from being
// claimed, and lasts until a resume. A stop cancels what is running (which closes the Tank's processes through the
// run's Scope) and what is queued, and leaves nothing behind: new work is accepted right after.
export type ScopeTarget = { readonly _tag: "Global" } | { readonly _tag: "Bot"; readonly botId: BotId }
export type StopTarget = ScopeTarget | { readonly _tag: "Task"; readonly taskId: TaskId }

export const GLOBAL: ScopeTarget = { _tag: "Global" }
export const botTarget = (botId: BotId): ScopeTarget => ({ _tag: "Bot", botId })
export const taskTarget = (taskId: TaskId): StopTarget => ({ _tag: "Task", taskId })

export interface StopReport {
  // Tasks this stop left `cancelled`: interrupted while running, or taken out of the queue. A task that finished on
  // its own in the meantime is not listed. Empty when there was nothing to stop.
  readonly tasks: ReadonlyArray<TaskId>
}

export interface ControlBotStatus {
  readonly id: BotId
  readonly name: string
  readonly state: BotState
  readonly paused: boolean
  readonly running: number
}

export interface ControlStatus {
  readonly paused: boolean
  readonly bots: ReadonlyArray<ControlBotStatus>
}

// What a run of the runner sees of its own stop.
export interface RunHandle {
  // Resolves with who asked, as soon as a stop is requested for this task (at once if it already was).
  readonly stopRequested: Effect.Effect<string>
  readonly isStopped: Effect.Effect<boolean>
}

export interface ControlShape {
  // `by` says who asked: it ends up in the verdict evidence and in control.changed.
  readonly stop: (target: StopTarget, by: string) => Effect.Effect<StopReport, NotFound | SqlError>
  readonly pause: (target: ScopeTarget, by: string) => Effect.Effect<void, NotFound | SqlError>
  readonly resume: (target: ScopeTarget, by: string) => Effect.Effect<void, NotFound | SqlError>
  readonly status: () => Effect.Effect<ControlStatus, SqlError>
  // Boot step: tasks still `running` in the database belong to a process that no longer exists (control-recovery.ts).
  readonly recoverOrphans: () => Effect.Effect<RecoveryReport>
  // Registers a run of a task while the scope lives; the runner reads its stop signal from the handle.
  readonly track: (taskId: TaskId, botId: BotId) => Effect.Effect<RunHandle, never, Scope.Scope>
}

export class Control extends Context.Service<Control, ControlShape>()("@shoalwork/Control") {}

export interface ControlDeps {
  readonly sql: SqlClient
  readonly beacon: BeaconShape
  readonly tasks: TaskStoreShape
  readonly bots: BotRegistryShape
  // How long a stop waits for an interrupted run to finish its cleanup (SIGTERM grace 5 s + SIGKILL grace 5 s).
  readonly stopWaitMs: number
}

interface Entry {
  readonly botId: BotId
  readonly stop: Deferred.Deferred<string>
  // Completed when the run has left the scope: its task is settled by then.
  readonly done: Deferred.Deferred<void>
}

const IdRow = Schema.Struct({ id: TaskIdSchema })

// A task a stop can still act on: anything that has not reached done, failed or cancelled (waiting_approval too).
const isOpen = (state: string): boolean => state !== "done" && state !== "failed" && state !== "cancelled"

export const makeControl = (deps: ControlDeps): ControlShape => {
  const { sql, beacon, tasks, bots } = deps
  const lifecycle = makeLifecycle({ beacon, tasks, bots })
  const flags = makeControlFlags({ sql, bots, tasks })
  const running = new Map<TaskId, Entry>()

  const streamOf = (target: StopTarget): string =>
    target._tag === "Global"
      ? streamIds.system
      : target._tag === "Bot"
        ? streamIds.bot(target.botId)
        : streamIds.task(target.taskId)

  const scopeName = (target: StopTarget): string =>
    target._tag === "Task" ? `task:${target.taskId}` : scopeOf(target)

  const record = (
    target: StopTarget,
    action: "pause" | "resume" | "stop",
    by: string,
    affected: ReadonlyArray<TaskId>,
  ) =>
    emit(beacon, {
      streamId: streamOf(target),
      type: "control.changed",
      payload: { scope: scopeName(target), action, by, tasks: affected },
      actor: by,
      correlationId: crypto.randomUUID(),
    })

  // A stop that outlives its wait is reported, never silent: the run may still be cleaning up.
  const waitForRun = (taskId: TaskId, entry: Entry) =>
    Deferred.await(entry.done).pipe(
      Effect.timeoutOption(Duration.millis(deps.stopWaitMs)),
      Effect.flatMap((finished) =>
        Option.isSome(finished)
          ? Effect.void
          : Effect.logWarning("stopped run did not finish in time", taskId).pipe(
              Effect.andThen(
                emit(beacon, {
                  streamId: streamIds.task(taskId),
                  type: "error.raised",
                  payload: {
                    where: "lead.control",
                    tag: "StopTimeout",
                    message: "the run did not finish within the stop wait",
                    taskId,
                    botId: entry.botId,
                  },
                  actor: "system:lead",
                  correlationId: taskId,
                }),
              ),
            ),
      ),
    )

  // Stops one task. Tracked: signals the run and waits until its cleanup is done. Not tracked: closes the task
  // directly (it never ran, or its process is gone). The job is closed as stopped in both cases. Returns whether the
  // task ended up cancelled.
  const stopOne = (taskId: TaskId, by: string): Effect.Effect<boolean, NotFound | SqlError> =>
    Effect.gen(function* () {
      const entry = running.get(taskId)
      if (entry !== undefined) {
        yield* Deferred.succeed(entry.stop, by)
        yield* waitForRun(taskId, entry)
      } else {
        const found = yield* tasks.get(taskId)
        if (!isOpen(found.state)) {
          return false
        }
        if (found.state === "running") {
          yield* lifecycle.finish(found.spec, stoppedVerdict(by), 0, {
            ...INITIAL,
            outcome: { _tag: "Stopped", by },
          })
        } else {
          yield* lifecycle.cancelUnstarted(found.spec, by)
        }
      }
      yield* closeJobsOf(sql, taskId, `stopped by ${by}`)
      return (yield* tasks.get(taskId)).state === "cancelled"
    })

  // Every task of the scope a stop can act on: running, waiting for approval, or not started yet (queued, or claimed
  // and not yet tracked), plus the runs this process tracks.
  const openIn = (target: ScopeTarget) =>
    Effect.gen(function* () {
      const ids = new Set<TaskId>()
      for (const [id, entry] of running) {
        if (target._tag === "Global" || entry.botId === target.botId) {
          ids.add(id)
        }
      }
      const rows =
        target._tag === "Global"
          ? yield* sql`SELECT id FROM tasks WHERE state NOT IN ('done', 'failed', 'cancelled')`
          : yield* sql`SELECT id FROM tasks WHERE bot_id = ${target.botId}
              AND state NOT IN ('done', 'failed', 'cancelled')`
      const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(IdRow))(rows).pipe(Effect.orDie)
      for (const row of decoded) {
        ids.add(row.id)
      }
      return Array.from(ids)
    })

  // A Bot left with nothing running is idle again (unless it is paused, which only a resume changes).
  const freeBots = (botIds: ReadonlyArray<BotId>) =>
    Effect.gen(function* () {
      const all = yield* bots.list()
      for (const id of new Set(botIds)) {
        const state = all.find((bot) => bot.id === id)?.state
        if ((state === "working" || state === "waiting_approval") && (yield* tasks.countRunning(id)) === 0) {
          yield* bots.setState(id, "idle")
        }
      }
    })

  const stopMany = (ids: ReadonlyArray<TaskId>, by: string) =>
    Effect.gen(function* () {
      const results = yield* Effect.forEach(ids, (id) => stopOne(id, by), { concurrency: "unbounded" })
      const cancelled = ids.filter((_, index) => results[index] === true)
      const owners = yield* Effect.forEach(cancelled, (id) =>
        Effect.map(tasks.get(id), (record) => record.spec.botId),
      )
      yield* freeBots(owners)
      return cancelled
    })

  const stop: ControlShape["stop"] = (target, by) =>
    Effect.gen(function* () {
      if (target._tag === "Task") {
        const known = yield* tasks.get(target.taskId)
        const cancelled = isOpen(known.state) ? yield* stopMany([target.taskId], by) : []
        if (cancelled.length > 0) {
          yield* record(target, "stop", by, cancelled)
        }
        return { tasks: cancelled }
      }
      if (target._tag === "Bot") {
        yield* bots.get(target.botId)
      }
      const cancelled = yield* stopMany(yield* openIn(target), by)
      yield* record(target, "stop", by, cancelled)
      return { tasks: cancelled }
    })

  const pause: ControlShape["pause"] = (target, by) =>
    Effect.gen(function* () {
      yield* flags.applyPause(target)
      yield* record(target, "pause", by, [])
    })

  const resume: ControlShape["resume"] = (target, by) =>
    Effect.gen(function* () {
      yield* flags.applyResume(target)
      yield* record(target, "resume", by, [])
    })

  const status: ControlShape["status"] = () =>
    Effect.gen(function* () {
      const paused = yield* flags.pausedScopes
      const all = yield* bots.list()
      const rows = yield* Effect.forEach(all, (bot) =>
        Effect.map(
          tasks.countRunning(bot.id),
          (count): ControlBotStatus => ({
            id: bot.id,
            name: bot.name,
            state: bot.state,
            paused: paused.has(botScope(bot.id)),
            running: count,
          }),
        ),
      )
      return { paused: paused.has(GLOBAL_SCOPE), bots: rows }
    })

  const track: ControlShape["track"] = (taskId, botId) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const entry: Entry = { botId, stop: Deferred.makeUnsafe<string>(), done: Deferred.makeUnsafe<void>() }
        running.set(taskId, entry)
        return entry
      }),
      (entry) =>
        Effect.sync(() => {
          // A redelivered job may have registered a newer run of the same task.
          if (running.get(taskId) === entry) {
            running.delete(taskId)
          }
          Deferred.doneUnsafe(entry.done, Effect.void)
        }),
    ).pipe(
      Effect.map(
        (entry): RunHandle => ({
          stopRequested: Deferred.await(entry.stop),
          isStopped: Effect.sync(() => Deferred.isDoneUnsafe(entry.stop)),
        }),
      ),
    )

  const recoverOrphans = makeRecovery({ sql, tasks, bots, lifecycle })

  return { stop, pause, resume, status, recoverOrphans, track }
}
