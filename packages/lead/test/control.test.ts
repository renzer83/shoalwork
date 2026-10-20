import { it } from "@effect/vitest"
import { BotRegistry } from "@shoalwork/bots"
import type { Bot, BotId, ExecutorEvent, TaskId } from "@shoalwork/contracts"
import { Jobs } from "@shoalwork/db"
import { Deferred, Duration, Effect, Option, Stream } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { botTarget, Control, GLOBAL, taskTarget } from "../src/control.js"
import type { TaskStoreShape } from "../src/tasks.js"
import { newBot } from "./conversation-support.js"
import {
  allEvents,
  createBot,
  eventsOf,
  fakeExecutor,
  Lead,
  leadLayer,
  makeFakeTank,
  OK_EVENTS,
  type Runs,
  specFor,
} from "./support.js"

const FAST = { heartbeatMs: 20, reapEveryMs: 20, staleSeconds: 60 } as const

const until = <E, R>(check: Effect.Effect<boolean, E, R>) =>
  Effect.gen(function* () {
    while (!(yield* check)) {
      yield* Effect.sleep(Duration.millis(10))
    }
  })

const secondBot = Effect.gen(function* () {
  const registry = yield* BotRegistry
  return yield* registry.upsert(newBot("other-bot", "developer"), "test")
})

const jobRows = Effect.gen(function* () {
  const sql = yield* SqlClient
  return yield* sql<{
    readonly state: string
    readonly attempts: number
    readonly last_error: string | null
  }>`SELECT state, attempts, last_error FROM jobs ORDER BY id`
})

const jobStates = Effect.map(jobRows, (rows) => rows.map((row) => row.state))

const botState = (id: BotId) =>
  Effect.gen(function* () {
    const registry = yield* BotRegistry
    return (yield* registry.list()).find((bot) => bot.id === id)?.state
  })

const eventsOfType = (type: string) =>
  Effect.map(allEvents, (events) => Array.from(events).filter((event) => event.type === type))

// Stands in for a process: a prompt that says "hang" never ends and takes `cleanupMs` to die once interrupted.
// `killed` lists the tasks whose "process" is gone, in order.
const hangingExecutor = (killed: Array<TaskId>, cleanupMs = 80) =>
  fakeExecutor((task) =>
    task.prompt.includes("hang")
      ? Stream.fromEffect(
          Effect.never.pipe(
            Effect.onInterrupt(() =>
              Effect.sleep(Duration.millis(cleanupMs)).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    killed.push(task.taskId)
                  }),
                ),
              ),
            ),
          ),
        )
      : eventsOf(OK_EVENTS)(),
  )

const hang = (bot: Bot) => specFor(bot, { prompt: "hang until stopped" })

const running = (...ids: ReadonlyArray<TaskId>) =>
  until(
    Effect.gen(function* () {
      const lead = yield* Lead
      const views = yield* Effect.forEach(ids, (id) => lead.get(id))
      return views.every((view) => view.state === "running")
    }),
  )

describe("Control.stop", () => {
  it.live(
    "stop(global) cancels running and queued tasks, kills the processes, and leaves no pause behind",
    () => {
      const killed: Array<TaskId> = []
      return Effect.gen(function* () {
        const lead = yield* Lead
        const control = yield* Control
        const one = yield* createBot
        const two = yield* secondBot
        const first = yield* lead.intake(hang(one))
        const second = yield* lead.intake(hang(two))
        // Concurrency 2 is taken: this one stays queued.
        const queued = yield* lead.intake(specFor(one))
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* lead.startWorker({ concurrency: 2, pollMs: 10 })
            yield* running(first.id, second.id)

            const report = yield* control.stop(GLOBAL, "user:test")

            // The processes were already gone when stop returned.
            expect(killed.slice().sort()).toEqual([first.id, second.id].sort())
            expect(report.tasks.slice().sort()).toEqual([first.id, second.id, queued.id].sort())
            for (const id of [first.id, second.id, queued.id]) {
              const view = yield* lead.get(id)
              expect(view.state).toBe("cancelled")
              expect(view.verdict).toMatchObject({ kind: "blocked", evidence: ["stopped by user:test"] })
            }
            const events = Array.from(yield* allEvents)
            // Only the two runs executed: the queued task has no executor.finished.
            expect(events.filter((event) => event.type === "executor.finished")).toHaveLength(2)
            const cancelled = events
              .filter((event) => event.type === "task.state_changed")
              .map((event) => event.payload)
              .filter((payload) => typeof payload === "object" && payload !== null && "to" in payload)
              .filter((payload) => payload.to === "cancelled")
            expect(cancelled).toHaveLength(3)
            expect(cancelled.every((payload) => "reason" in payload)).toBe(true)
            expect((yield* eventsOfType("control.changed")).map((event) => event.payload)).toEqual([
              {
                scope: "global",
                action: "stop",
                by: "user:test",
                tasks: expect.arrayContaining([first.id, second.id, queued.id]),
              },
            ])
            // Every job is closed as stopped, none left for redelivery.
            yield* until(Effect.map(jobStates, (states) => states.every((state) => state === "failed")))
            for (const row of yield* jobRows) {
              expect(row.last_error).toBe("stopped by user:test")
            }
            // A stop is not a pause: the Bots are free and new work runs at once.
            expect(yield* botState(one.id)).toBe("idle")
            expect(yield* botState(two.id)).toBe("idle")
            expect((yield* control.status()).paused).toBe(false)
            const next = yield* lead.intake(specFor(one))
            yield* until(Effect.map(lead.get(next.id), (view) => view.state === "done"))
          }),
        )
      }).pipe(Effect.provide(leadLayer({ executor: hangingExecutor(killed), config: FAST })))
    },
  )

  it.live("stop(bot) stops that Bot's running and queued tasks only; the other Bot keeps running", () => {
    const killed: Array<TaskId> = []
    return Effect.gen(function* () {
      const lead = yield* Lead
      const control = yield* Control
      const one = yield* createBot
      const two = yield* secondBot
      const stopped = yield* lead.intake(hang(one))
      const kept = yield* lead.intake(hang(two))
      const waiting = yield* lead.intake(specFor(one))
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* lead.startWorker({ concurrency: 2, pollMs: 10 })
          yield* running(stopped.id, kept.id)

          const report = yield* control.stop(botTarget(one.id), "user:test")

          expect(report.tasks.slice().sort()).toEqual([stopped.id, waiting.id].sort())
          expect(killed).toEqual([stopped.id])
          expect((yield* lead.get(stopped.id)).state).toBe("cancelled")
          expect((yield* lead.get(waiting.id)).state).toBe("cancelled")
          expect((yield* lead.get(kept.id)).state).toBe("running")
          expect(yield* botState(one.id)).toBe("idle")
          expect(yield* botState(two.id)).toBe("working")

          const single = yield* control.stop(taskTarget(kept.id), "user:test")
          expect(single.tasks).toEqual([kept.id])
          expect(killed).toEqual([stopped.id, kept.id])
          expect(yield* botState(two.id)).toBe("idle")
        }),
      )
    }).pipe(Effect.provide(leadLayer({ executor: hangingExecutor(killed), config: FAST })))
  })

  it.live("a stopped task is not retried and keeps its worktree for diagnosis", () => {
    const killed: Array<TaskId> = []
    const tank = makeFakeTank()
    return Effect.gen(function* () {
      const lead = yield* Lead
      const control = yield* Control
      const bot = yield* createBot
      const spec = yield* lead.intake(hang(bot))
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* lead.startWorker({ concurrency: 1, pollMs: 10 })
          yield* running(spec.id)
          yield* control.stop(taskTarget(spec.id), "user:test")
          yield* Effect.sleep(Duration.millis(100))
        }),
      )
      expect(tank.prepared).toHaveLength(1)
      expect(tank.released).toEqual([{ keepWorktree: true }])
      expect((yield* lead.get(spec.id)).state).toBe("cancelled")
    }).pipe(Effect.provide(leadLayer({ executor: hangingExecutor(killed), config: FAST, tank })))
  })

  it.live("stop(task) cancels a queued task without any executor event and closes its job", () =>
    Effect.gen(function* () {
      const lead = yield* Lead
      const control = yield* Control
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot))

      const report = yield* control.stop(taskTarget(spec.id), "api")

      expect(report.tasks).toEqual([spec.id])
      const view = yield* lead.get(spec.id)
      expect(view.state).toBe("cancelled")
      expect(view.verdict).toMatchObject({ kind: "blocked", evidence: ["stopped by api"] })
      expect(yield* jobRows).toEqual([{ state: "failed", attempts: 3, last_error: "stopped by api" }])
      expect(Array.from(yield* allEvents).map((event) => event.type)).not.toContain("executor.finished")
      expect((yield* control.stop(taskTarget(spec.id), "api")).tasks).toEqual([])
    }).pipe(Effect.provide(leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS)), config: FAST }))),
  )

  it.live("stop(task) of a task whose process is gone (running in the database only) cancels it", () =>
    Effect.gen(function* () {
      const lead = yield* Lead
      const control = yield* Control
      const sql = yield* SqlClient
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot))
      yield* sql`UPDATE tasks SET state = 'running' WHERE id = ${spec.id}`
      yield* sql`UPDATE jobs SET state = 'active', attempts = 1`
      const registry = yield* BotRegistry
      yield* registry.setState(bot.id, "working", spec.id)

      yield* control.stop(taskTarget(spec.id), "watchdog")

      const view = yield* lead.get(spec.id)
      expect(view.state).toBe("cancelled")
      expect(view.verdict).toMatchObject({ evidence: ["stopped by watchdog"] })
      expect(yield* jobStates).toEqual(["failed"])
      expect(Array.from(yield* allEvents).map((event) => event.type)).toContain("executor.finished")
      expect(yield* botState(bot.id)).toBe("idle")
    }).pipe(Effect.provide(leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS)), config: FAST }))),
  )

  it.live("a task waiting for approval can be stopped", () =>
    Effect.gen(function* () {
      const lead = yield* Lead
      const control = yield* Control
      const sql = yield* SqlClient
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot))
      yield* sql`UPDATE tasks SET state = 'waiting_approval' WHERE id = ${spec.id}`
      const registry = yield* BotRegistry
      yield* registry.setState(bot.id, "waiting_approval", spec.id)

      const report = yield* control.stop(taskTarget(spec.id), "user:test")

      expect(report.tasks).toEqual([spec.id])
      expect((yield* lead.get(spec.id)).state).toBe("cancelled")
      expect(yield* botState(bot.id)).toBe("idle")
    }).pipe(Effect.provide(leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS)), config: FAST }))),
  )

  it.live("stop(task) of an unknown task is NotFound and of a finished task changes nothing", () =>
    Effect.gen(function* () {
      const lead = yield* Lead
      const control = yield* Control
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot))
      yield* lead.runOnce(spec.id)
      expect((yield* lead.get(spec.id)).state).toBe("done")

      expect((yield* control.stop(taskTarget(spec.id), "api")).tasks).toEqual([])
      expect((yield* lead.get(spec.id)).state).toBe("done")
      const missing = yield* Effect.flip(
        control.stop(taskTarget("task_00000000-0000-4000-8000-0000000000ff" as TaskId), "api"),
      )
      expect(missing._tag).toBe("NotFound")
    }).pipe(Effect.provide(leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS)), config: FAST }))),
  )

  it.live(
    "a stop racing the natural end settles the task once and lists it only when it was cancelled",
    () => {
      const gate = Deferred.makeUnsafe<void>()
      const executor = fakeExecutor(() =>
        Stream.fromEffect(
          Deferred.await(gate).pipe(Effect.as<ExecutorEvent>({ kind: "done", result: "ok", artifacts: [] })),
        ),
      )
      return Effect.gen(function* () {
        const lead = yield* Lead
        const control = yield* Control
        const bot = yield* createBot
        const spec = yield* lead.intake(specFor(bot))
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* lead.startWorker({ concurrency: 1, pollMs: 10 })
            yield* running(spec.id)
            const [report] = yield* Effect.all(
              [control.stop(taskTarget(spec.id), "user:test"), Deferred.succeed(gate, undefined)],
              { concurrency: "unbounded" },
            )
            yield* until(Effect.map(jobStates, (states) => states.every((state) => state !== "active")))
            const view = yield* lead.get(spec.id)
            expect(["done", "cancelled"]).toContain(view.state)
            // Whatever won, the task closed once and the report agrees with the final state.
            expect(report.tasks.includes(spec.id)).toBe(view.state === "cancelled")
            expect(yield* eventsOfType("executor.finished")).toHaveLength(1)
            const finals = (yield* eventsOfType("task.state_changed")).filter((event) =>
              ["done", "cancelled"].includes(String((event.payload as { readonly to?: string }).to)),
            )
            expect(finals).toHaveLength(1)
          }),
        )
      }).pipe(Effect.provide(leadLayer({ executor, config: FAST })))
    },
  )

  it.live("a stop that arrives between two rounds of a retry ends the task without another run", () => {
    const runs: Runs = []
    const executor = fakeExecutor(
      () => Stream.make({ kind: "error" as const, code: "max_turns" as const, message: "turn limit" }),
      runs,
    )
    let stopper: Effect.Effect<unknown, unknown> | undefined
    let fired = false
    // Right after the first round is recorded for a retry, a stop is requested.
    const wrapStore = (real: TaskStoreShape): TaskStoreShape => ({
      ...real,
      update: (id, patch) =>
        Effect.gen(function* () {
          const before = yield* real.update(id, patch)
          if (patch.state === undefined && !fired && stopper !== undefined) {
            fired = true
            const request = stopper
            yield* Effect.sync(() => {
              void Effect.runFork(request)
            })
            yield* Effect.sleep(Duration.millis(30))
          }
          return before
        }),
    })
    return Effect.gen(function* () {
      const lead = yield* Lead
      const control = yield* Control
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot))
      stopper = control.stop(taskTarget(spec.id), "user:test")
      yield* lead.runOnce(spec.id)
      yield* Effect.sleep(Duration.millis(50))

      expect(runs).toHaveLength(1)
      const view = yield* lead.get(spec.id)
      expect(view.state).toBe("cancelled")
      expect(view.verdict).toMatchObject({ evidence: ["stopped by user:test"] })
      // The only run that happened has its executor.finished; the cancelled retry has none.
      expect(yield* eventsOfType("executor.finished")).toHaveLength(1)
    }).pipe(Effect.provide(leadLayer({ executor, config: FAST, wrapStore })))
  })

  it.live("a task cancelled between the claim and the registration is not run", () => {
    const runs: Runs = []
    let reads = 0
    // The second read of the task is the one after the stop registration: the task is cancelled just before it.
    const wrapStore = (real: TaskStoreShape): TaskStoreShape => ({
      ...real,
      get: (id) =>
        Effect.gen(function* () {
          reads += 1
          if (reads === 2) {
            yield* real.update(id, { state: "cancelled" })
          }
          return yield* real.get(id)
        }),
    })
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot))
      reads = 0
      const verdict = yield* lead.runOnce(spec.id)

      expect(runs).toHaveLength(0)
      expect(verdict.kind).toBe("blocked")
      expect((yield* lead.get(spec.id)).state).toBe("cancelled")
    }).pipe(
      Effect.provide(
        leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS), runs), config: FAST, wrapStore }),
      ),
    )
  })

  it.live("a stop whose run does not finish in time is reported, not silent", () => {
    const killed: Array<TaskId> = []
    return Effect.gen(function* () {
      const lead = yield* Lead
      const control = yield* Control
      const bot = yield* createBot
      const spec = yield* lead.intake(hang(bot))
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* lead.startWorker({ concurrency: 1, pollMs: 10 })
          yield* running(spec.id)
          yield* control.stop(taskTarget(spec.id), "user:test")
          const errors = (yield* eventsOfType("error.raised")).map((event) => event.payload)
          expect(errors).toContainEqual(expect.objectContaining({ tag: "StopTimeout", taskId: spec.id }))
          // The run does finish its cleanup afterwards.
          yield* until(Effect.sync(() => killed.length === 1))
        }),
      )
    }).pipe(
      Effect.provide(
        leadLayer({ executor: hangingExecutor(killed, 400), config: { ...FAST, stopWaitMs: 50 } }),
      ),
    )
  })
})

describe("Control.pause and resume", () => {
  it.live("a paused scope is not claimed; resume lets the worker claim again", () =>
    Effect.gen(function* () {
      const lead = yield* Lead
      const control = yield* Control
      const bot = yield* createBot
      yield* control.pause(GLOBAL, "user:test")
      const spec = yield* lead.intake(specFor(bot))
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* lead.startWorker({ concurrency: 1, pollMs: 10 })
          yield* Effect.sleep(Duration.millis(150))
          expect((yield* lead.get(spec.id)).state).toBe("received")
          expect(yield* jobStates).toEqual(["queued"])

          yield* control.resume(GLOBAL, "user:test")
          yield* until(Effect.map(lead.get(spec.id), (view) => view.state === "done"))
          expect(yield* botState(bot.id)).toBe("idle")
        }),
      )
    }).pipe(Effect.provide(leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS)), config: FAST }))),
  )

  it.live("pausing one Bot holds its tasks only", () =>
    Effect.gen(function* () {
      const lead = yield* Lead
      const control = yield* Control
      const one = yield* createBot
      const two = yield* secondBot
      yield* control.pause(botTarget(one.id), "user:test")
      const held = yield* lead.intake(specFor(one))
      const free = yield* lead.intake(specFor(two))
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* lead.startWorker({ concurrency: 1, pollMs: 10 })
          yield* until(Effect.map(lead.get(free.id), (view) => view.state === "done"))
          yield* Effect.sleep(Duration.millis(100))
          expect((yield* lead.get(held.id)).state).toBe("received")
          expect(yield* botState(one.id)).toBe("paused")

          yield* control.resume(botTarget(one.id), "user:test")
          yield* until(Effect.map(lead.get(held.id), (view) => view.state === "done"))
          expect(yield* botState(one.id)).toBe("idle")
        }),
      )
    }).pipe(Effect.provide(leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS)), config: FAST }))),
  )

  it.live("a pause does not interrupt a running task, and the Bot stays paused after it finishes", () => {
    const executor = fakeExecutor(() =>
      Stream.fromEffect(
        Effect.sleep(Duration.millis(200)).pipe(
          Effect.as<ExecutorEvent>({ kind: "done", result: "ok", artifacts: [] }),
        ),
      ),
    )
    return Effect.gen(function* () {
      const lead = yield* Lead
      const control = yield* Control
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot))
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* lead.startWorker({ concurrency: 1, pollMs: 10 })
          yield* running(spec.id)
          yield* control.pause(botTarget(bot.id), "user:test")
          expect((yield* lead.get(spec.id)).state).toBe("running")
          yield* until(Effect.map(lead.get(spec.id), (view) => view.state === "done"))
          expect(yield* botState(bot.id)).toBe("paused")
        }),
      )
      expect(yield* eventsOfType("control.changed")).toHaveLength(1)
    }).pipe(Effect.provide(leadLayer({ executor, config: FAST })))
  })

  it.live("a stop does not touch a pause that was set before it", () => {
    const killed: Array<TaskId> = []
    return Effect.gen(function* () {
      const lead = yield* Lead
      const control = yield* Control
      const one = yield* createBot
      const spec = yield* lead.intake(hang(one))
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* lead.startWorker({ concurrency: 1, pollMs: 10 })
          yield* running(spec.id)
          yield* control.pause(botTarget(one.id), "user:test")
          yield* control.stop(botTarget(one.id), "user:test")
          expect(yield* botState(one.id)).toBe("paused")
          expect((yield* control.status()).bots[0]?.paused).toBe(true)
        }),
      )
    }).pipe(Effect.provide(leadLayer({ executor: hangingExecutor(killed), config: FAST })))
  })

  it.live("resume of the global scope keeps a Bot paused on its own paused", () =>
    Effect.gen(function* () {
      const control = yield* Control
      const one = yield* createBot
      const two = yield* secondBot
      yield* control.pause(botTarget(one.id), "user:test")
      yield* control.pause(GLOBAL, "user:test")
      yield* control.resume(GLOBAL, "user:test")
      expect(yield* botState(one.id)).toBe("paused")
      expect(yield* botState(two.id)).toBe("idle")
      const status = yield* control.status()
      expect(status.paused).toBe(false)
      expect(status.bots.find((bot) => bot.id === one.id)?.paused).toBe(true)
    }).pipe(Effect.provide(leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS)), config: FAST }))),
  )

  it.live("an unknown Bot is NotFound", () =>
    Effect.gen(function* () {
      const control = yield* Control
      const failure = yield* Effect.flip(
        control.pause(botTarget("bot_00000000-0000-4000-8000-0000000000ff" as BotId), "api"),
      )
      expect(failure._tag).toBe("NotFound")
    }).pipe(Effect.provide(leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS)), config: FAST }))),
  )
})

describe("Control.recoverOrphans", () => {
  // A task the previous process left running: its job is active with `attempts` used out of 3.
  const orphan = (bot: Bot, attempts: number, prompt = "Implement the feature.") =>
    Effect.gen(function* () {
      const lead = yield* Lead
      const sql = yield* SqlClient
      const spec = yield* lead.intake(specFor(bot, { prompt }))
      yield* sql`UPDATE tasks SET state = 'running', attempts = 1 WHERE id = ${spec.id}`
      yield* sql`UPDATE jobs SET state = 'active', attempts = ${attempts}
        WHERE json_extract(payload, '$.taskId') = ${spec.id}`
      const registry = yield* BotRegistry
      yield* registry.setState(bot.id, "working", spec.id)
      return spec
    })

  const reasons = Effect.map(eventsOfType("task.state_changed"), (events) =>
    events
      .map((event) => event.payload)
      .filter((payload) => typeof payload === "object" && payload !== null && "reason" in payload)
      .map((payload) => payload.reason),
  )

  it.live(
    "a task with attempts left goes back to the queue, stays running, and the worker continues it",
    () => {
      const runs: Array<{ readonly prompt: string }> = []
      return Effect.gen(function* () {
        const lead = yield* Lead
        const control = yield* Control
        const bot = yield* createBot
        const spec = yield* orphan(bot, 1)

        const report = yield* control.recoverOrphans()

        expect(report).toEqual({ resumed: [spec.id], failed: [] })
        expect((yield* lead.get(spec.id)).state).toBe("running")
        // The attempts of the job are kept, so a crash loop runs out of them.
        expect(yield* jobRows).toEqual([{ state: "queued", attempts: 1, last_error: null }])
        expect(yield* reasons).toEqual(["process restarted, resuming"])
        expect(yield* botState(bot.id)).toBe("working")

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* lead.startWorker({ concurrency: 1, pollMs: 10 })
            yield* until(Effect.map(lead.get(spec.id), (view) => view.state === "done"))
          }),
        )
        // It continued the interrupted run instead of starting over, and did not count a new attempt.
        expect(runs).toHaveLength(1)
        expect(runs[0]?.prompt).toContain("Continue from where you stopped")
        expect((yield* (yield* Lead).get(spec.id)).state).toBe("done")
        expect(yield* botState(bot.id)).toBe("idle")
      }).pipe(
        Effect.provide(
          leadLayer({
            executor: fakeExecutor((task) => {
              runs.push({ prompt: task.prompt })
              return eventsOf(OK_EVENTS)()
            }),
            config: FAST,
          }),
        ),
      )
    },
  )

  it.live("a task whose job has no attempt left fails with 'process restarted' and its job is closed", () =>
    Effect.gen(function* () {
      const lead = yield* Lead
      const control = yield* Control
      const bot = yield* createBot
      const spent = yield* orphan(bot, 3)
      const waiting = yield* lead.intake(specFor(bot))

      const report = yield* control.recoverOrphans()

      expect(report).toEqual({ resumed: [], failed: [spent.id] })
      expect((yield* lead.get(spent.id)).state).toBe("failed")
      expect((yield* lead.get(waiting.id)).state).toBe("received")
      expect((yield* jobStates).sort()).toEqual(["failed", "queued"])
      expect(yield* botState(bot.id)).toBe("idle")
      expect(yield* reasons).toEqual(["process restarted"])
      expect((yield* control.recoverOrphans()).failed).toEqual([])
    }).pipe(Effect.provide(leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS)), config: FAST }))),
  )

  it.live("a running task with no job fails", () =>
    Effect.gen(function* () {
      const lead = yield* Lead
      const control = yield* Control
      const sql = yield* SqlClient
      const bot = yield* createBot
      const spec = yield* orphan(bot, 1)
      yield* sql`DELETE FROM jobs`

      const report = yield* control.recoverOrphans()

      expect(report.failed).toEqual([spec.id])
      expect((yield* lead.get(spec.id)).state).toBe("failed")
    }).pipe(Effect.provide(leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS)), config: FAST }))),
  )

  it.live(
    "a task that keeps killing the process runs out of attempts after a bounded number of restarts",
    () =>
      Effect.gen(function* () {
        const lead = yield* Lead
        const control = yield* Control
        const bot = yield* createBot
        const spec = yield* orphan(bot, 1)
        let boots = 0
        // Each "boot": recover, the worker claims the job (one more attempt) and the process dies again.
        while (true) {
          boots += 1
          const report = yield* control.recoverOrphans()
          if (report.failed.includes(spec.id)) break
          expect(report.resumed).toEqual([spec.id])
          expect(Option.isSome(yield* Jobs.claim("tasks"))).toBe(true)
          expect(boots).toBeLessThan(10)
        }

        // Attempts 1 (given), then claims 2 and 3: the third boot finds none left.
        expect(boots).toBe(3)
        expect((yield* lead.get(spec.id)).state).toBe("failed")
        expect(yield* jobStates).toEqual(["failed"])
      }).pipe(Effect.provide(leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS)), config: FAST }))),
  )

  it.live("one task that cannot be recovered does not stop the others", () => {
    let broken: TaskId | undefined
    const wrapStore = (real: TaskStoreShape): TaskStoreShape => ({
      ...real,
      get: (id) => (id === broken ? Effect.die("database unavailable") : real.get(id)),
    })
    return Effect.gen(function* () {
      const lead = yield* Lead
      const control = yield* Control
      const bot = yield* createBot
      const bad = yield* orphan(bot, 1)
      const good = yield* orphan(bot, 1)
      broken = bad.id

      const report = yield* control.recoverOrphans()

      expect(report.resumed).toEqual([good.id])
      expect(report.failed).toEqual([])
      broken = undefined
      expect((yield* lead.get(bad.id)).state).toBe("running")
      const errors = (yield* eventsOfType("error.raised")).map((event) => event.payload)
      expect(errors).toContainEqual(expect.objectContaining({ where: "lead.recover", taskId: bad.id }))
    }).pipe(
      Effect.provide(leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS)), config: FAST, wrapStore })),
    )
  })
})
