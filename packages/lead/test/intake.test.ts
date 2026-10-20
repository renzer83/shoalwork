import { it } from "@effect/vitest"
import { NotFound, SchemaViolation, streamIds } from "@shoalwork/contracts"
import { Jobs } from "@shoalwork/db"
import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import {
  allEvents,
  createBot,
  eventsOf,
  fakeExecutor,
  Lead,
  leadLayer,
  OK_EVENTS,
  specFor,
} from "./support.js"

const layer = () => leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS)) })

describe("Lead.intake", () => {
  it.effect("records task.received, queues exactly one job and get reports received", () =>
    Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot))
      expect(spec.id).toMatch(/^task_/)

      const events = (yield* allEvents).filter((event) => event.type === "task.received")
      expect(events).toHaveLength(1)
      expect(events[0]?.streamId).toBe(streamIds.task(spec.id))
      expect(events[0]?.payload).toMatchObject({ task: { id: spec.id, botId: bot.id, prompt: spec.prompt } })

      const sql = yield* SqlClient
      const jobs = yield* sql<{ readonly queue: string; readonly payload: string; readonly state: string }>`
        SELECT queue, payload, state FROM jobs`
      expect(jobs).toHaveLength(1)
      expect(jobs[0]?.queue).toBe("tasks")
      expect(jobs[0]?.state).toBe("queued")
      expect(JSON.parse(jobs[0]?.payload ?? "{}")).toEqual({ taskId: spec.id })

      const stored = yield* lead.get(spec.id)
      expect(stored.state).toBe("received")
      expect(stored.verdict).toBeUndefined()
      expect(stored.spec).toEqual(spec)
    }).pipe(Effect.provide(layer())),
  )

  it.effect("fails with NotFound for an unknown bot and leaves no task or job behind", () =>
    Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const unknown = specFor({ ...bot, id: "bot_00000000-0000-4000-8000-000000000000" as typeof bot.id })
      const error = yield* Effect.flip(lead.intake(unknown))
      expect(error).toBeInstanceOf(NotFound)

      const sql = yield* SqlClient
      expect(yield* sql`SELECT id FROM tasks`).toHaveLength(0)
      expect(yield* sql`SELECT id FROM jobs`).toHaveLength(0)
      expect((yield* allEvents).filter((event) => event.type === "task.received")).toHaveLength(0)
    }).pipe(Effect.provide(layer())),
  )

  it.effect("rejects a spec that does not satisfy the TaskSpec schema", () =>
    Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const error = yield* Effect.flip(
        lead.intake(specFor(bot, { budget: { tokens: 1.5, seconds: 60, usd: 1 } })),
      )
      expect(error).toBeInstanceOf(SchemaViolation)
      const sql = yield* SqlClient
      expect(yield* sql`SELECT id FROM tasks`).toHaveLength(0)
    }).pipe(Effect.provide(layer())),
  )

  it.effect("rolls back task.received, the task row and the job together when enqueue fails", () =>
    Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const sql = yield* SqlClient
      // A trigger makes every job insert fail, standing in for any error after the task row was written.
      yield* sql.unsafe(
        "CREATE TRIGGER refuse_jobs BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT, 'refused'); END",
      )
      const exit = yield* Effect.exit(lead.intake(specFor(bot)))
      expect(exit._tag).toBe("Failure")
      expect(yield* sql`SELECT id FROM tasks`).toHaveLength(0)
      expect(yield* sql`SELECT id FROM jobs`).toHaveLength(0)
      // The real Beacon writes through the same connection, so its event rolled back too.
      expect((yield* allEvents).filter((event) => event.type === "task.received")).toHaveLength(0)
      expect((yield* Jobs.claim("tasks"))._tag).toBe("None")
    }).pipe(Effect.provide(leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS)), liveBeacon: true }))),
  )
})
