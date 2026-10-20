import { it } from "@effect/vitest"
import { BotRegistry } from "@shoalwork/bots"
import { Jobs } from "@shoalwork/db"
import { Deferred, Duration, Effect, Ref, Stream } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import {
  allEvents,
  createBot,
  eventsOf,
  eventTypes,
  failFinalWrites,
  fakeExecutor,
  Lead,
  leadLayer,
  makeFakeTank,
  OK_EVENTS,
  specFor,
} from "./support.js"

const PAST = "2000-01-01T00:00:00.000Z"
const FAST = { heartbeatMs: 20, reapEveryMs: 20, staleSeconds: 60 } as const

// Polls until `check` holds; fails the test (via the vitest timeout) if it never does.
const until = <E, R>(check: Effect.Effect<boolean, E, R>) =>
  Effect.gen(function* () {
    while (!(yield* check)) {
      yield* Effect.sleep(Duration.millis(10))
    }
  })

const jobStates = Effect.gen(function* () {
  const sql = yield* SqlClient
  const rows = yield* sql<{ readonly state: string }>`SELECT state FROM jobs ORDER BY id`
  return rows.map((row) => row.state)
})

describe("Lead.startWorker", () => {
  it.live("processes two jobs at the same time with concurrency 2 and stops when the scope closes", () => {
    // Each run waits for the other one: it only finishes if both are executing concurrently.
    let started = 0
    const bothStarted = Deferred.makeUnsafe<void>()
    const executor = fakeExecutor((_task) =>
      Stream.fromEffect(
        Effect.gen(function* () {
          started += 1
          if (started === 2) {
            yield* Deferred.succeed(bothStarted, undefined)
          }
          yield* Deferred.await(bothStarted)
          return { kind: "done" as const, result: "ok", artifacts: [] }
        }),
      ),
    )
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const first = yield* lead.intake(specFor(bot))
      const second = yield* lead.intake(specFor(bot))

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* lead.startWorker({ concurrency: 2, pollMs: 10 })
          yield* until(
            Effect.gen(function* () {
              const states = yield* Effect.all([lead.get(first.id), lead.get(second.id)])
              return states.every((task) => task.state === "done")
            }),
          )
        }),
      )
      expect(yield* jobStates).toEqual(["done", "done"])

      // The scope is closed: a new task stays queued.
      const late = yield* lead.intake(specFor(bot))
      yield* Effect.sleep(Duration.millis(150))
      expect((yield* lead.get(late.id)).state).toBe("received")
      expect(yield* jobStates).toEqual(["done", "done", "queued"])
    }).pipe(Effect.provide(leadLayer({ executor, config: FAST })))
  })

  it.live("concurrency 1 never runs two tasks at once", () => {
    const active = Ref.makeUnsafe(0)
    const peak = Ref.makeUnsafe(0)
    const executor = fakeExecutor((_task) =>
      Stream.fromEffect(
        Effect.gen(function* () {
          const now = yield* Ref.updateAndGet(active, (n) => n + 1)
          yield* Ref.update(peak, (p) => Math.max(p, now))
          yield* Effect.sleep(Duration.millis(40))
          yield* Ref.update(active, (n) => n - 1)
          return { kind: "done" as const, result: "ok", artifacts: [] }
        }),
      ),
    )
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const ids = [
        (yield* lead.intake(specFor(bot))).id,
        (yield* lead.intake(specFor(bot))).id,
        (yield* lead.intake(specFor(bot))).id,
      ]
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* lead.startWorker({ concurrency: 1, pollMs: 10 })
          yield* until(
            Effect.gen(function* () {
              const tasks = yield* Effect.all(ids.map((id) => lead.get(id)))
              return tasks.every((task) => task.state === "done")
            }),
          )
        }),
      )
      expect(yield* Ref.get(peak)).toBe(1)
    }).pipe(Effect.provide(leadLayer({ executor, config: FAST })))
  })

  it.live(
    "a job whose lock was lost is abandoned: the task is not finished and the job not completed",
    () => {
      const tank = makeFakeTank()
      const executor = fakeExecutor(() => Stream.never)
      return Effect.gen(function* () {
        const lead = yield* Lead
        const sql = yield* SqlClient
        const bot = yield* createBot
        const spec = yield* lead.intake(specFor(bot))

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* lead.startWorker({ concurrency: 1, pollMs: 10 })
            yield* until(Effect.map(lead.get(spec.id), (task) => task.state === "running"))
            // Another party took the job away (here: marked it failed); the next heartbeat must notice.
            yield* sql`UPDATE jobs SET state = 'failed', last_error = 'taken'`
            yield* until(Effect.sync(() => tank.released.length > 0))
          }),
        )
        expect(tank.released).toEqual([{ keepWorktree: true }])
        expect(yield* jobStates).toEqual(["failed"])
        const stored = yield* lead.get(spec.id)
        expect(stored.state).toBe("running")
        expect(stored.verdict).toBeUndefined()
      }).pipe(Effect.provide(leadLayer({ executor, tank, config: FAST })))
    },
  )

  it.live("requeues a stale job (dead worker) and runs it", () =>
    Effect.gen(function* () {
      const lead = yield* Lead
      const sql = yield* SqlClient
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot))
      // Simulate a worker that claimed the job and died long ago.
      yield* Jobs.claim("tasks")
      yield* sql`UPDATE jobs SET heartbeat_at = ${PAST}`
      expect(yield* jobStates).toEqual(["active"])

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* lead.startWorker({ concurrency: 1, pollMs: 10 })
          yield* until(Effect.map(lead.get(spec.id), (task) => task.state === "done"))
        }),
      )
      expect(yield* jobStates).toEqual(["done"])
    }).pipe(Effect.provide(leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS)), config: FAST }))),
  )

  it.live("reports a job with an invalid payload as a failed attempt (retried with backoff, not run)", () =>
    Effect.gen(function* () {
      const lead = yield* Lead
      const sql = yield* SqlClient
      yield* Jobs.enqueue("tasks", { nothing: true })
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* lead.startWorker({ concurrency: 1, pollMs: 10 })
          yield* until(
            Effect.map(
              sql<{ readonly last_error: string | null }>`SELECT last_error FROM jobs`,
              (rows) => rows[0]?.last_error === "invalid job payload",
            ),
          )
        }),
      )
      expect(yield* jobStates).toEqual(["queued"])
    }).pipe(Effect.provide(leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS)), config: FAST }))),
  )

  it.live("does not complete the job when the verdict could not be recorded", () =>
    Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot))
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* lead.startWorker({ concurrency: 1, pollMs: 10 })
          yield* until(Effect.map(eventTypes, (types) => types.includes("error.raised")))
          yield* Effect.sleep(Duration.millis(100))
        }),
      )
      // The job stays active (heartbeat gone with the worker): the reaper will hand the task out again.
      expect(yield* jobStates).toEqual(["active"])
      expect((yield* lead.get(spec.id)).state).toBe("running")
    }).pipe(
      Effect.provide(
        leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS)), wrapStore: failFinalWrites, config: FAST }),
      ),
    ),
  )

  it.live("closes the task and frees the bot when its job is reaped to failed", () =>
    Effect.gen(function* () {
      const lead = yield* Lead
      const sql = yield* SqlClient
      const registry = yield* BotRegistry
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot))
      // The worker died on the last allowed attempt: task running, bot working, job active with an old heartbeat.
      const job = yield* Jobs.claim("tasks")
      expect(job._tag).toBe("Some")
      yield* sql`UPDATE jobs SET attempts = max_attempts, heartbeat_at = ${PAST}`
      yield* sql`UPDATE tasks SET state = 'running'`
      yield* registry.setState(bot.id, "working", spec.id)

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* lead.startWorker({ concurrency: 1, pollMs: 10 })
          yield* until(Effect.map(lead.get(spec.id), (task) => task.state === "failed"))
        }),
      )
      expect(yield* jobStates).toEqual(["failed"])
      const stored = yield* lead.get(spec.id)
      expect(stored.verdict).toMatchObject({ kind: "blocked", evidence: ["reaped: max attempts"] })
      expect((yield* registry.list())[0]?.state).toBe("idle")
      const raised = (yield* allEvents).filter((event) => event.type === "error.raised")
      expect(raised.map((event) => event.payload)).toMatchObject([
        { where: "lead.reaper", taskId: spec.id, botId: bot.id },
      ])
    }).pipe(Effect.provide(leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS)), config: FAST }))),
  )
})
