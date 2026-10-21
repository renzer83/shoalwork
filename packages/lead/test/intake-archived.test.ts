import { it } from "@effect/vitest"
import { BotRegistry } from "@shoalwork/bots"
import { NotFound } from "@shoalwork/contracts"
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

describe("Lead.intake and an archived Bot", () => {
  it.effect("refuses a new task for an archived Bot with NotFound and leaves no task or job", () =>
    Effect.gen(function* () {
      const lead = yield* Lead
      const registry = yield* BotRegistry
      const bot = yield* createBot
      yield* registry.setState(bot.id, "archived", undefined, "user:app")

      const error = yield* Effect.flip(lead.intake(specFor(bot)))
      expect(error).toBeInstanceOf(NotFound)

      const sql = yield* SqlClient
      expect(yield* sql`SELECT id FROM tasks`).toHaveLength(0)
      expect(yield* sql`SELECT id FROM jobs`).toHaveLength(0)
      expect((yield* allEvents).filter((event) => event.type === "task.received")).toHaveLength(0)
    }).pipe(Effect.provide(layer())),
  )

  it.effect("still accepts a task for a Bot that is not archived", () =>
    Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot))
      expect(spec.botId).toBe(bot.id)
      const sql = yield* SqlClient
      expect(yield* sql`SELECT id FROM tasks`).toHaveLength(1)
    }).pipe(Effect.provide(layer())),
  )
})
