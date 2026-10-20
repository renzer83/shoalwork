import { it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { describe, expect } from "vitest"
import {
  allEvents,
  createBot,
  eventsOf,
  fakeExecutor,
  Lead,
  leadLayer,
  makeFakeTank,
  OK_EVENTS,
  specFor,
} from "./support.js"

// The `where` of an error.raised payload (the same shape every cleanup step reports).
const ErrorPayload = Schema.Struct({ where: Schema.String })

describe("publishing the run's artifacts at the end of a run (T-172)", () => {
  it.effect("publishes once, for the task and its cwd, and the ok verdict stands", () => {
    const tank = makeFakeTank()
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot))
      const verdict = yield* lead.runOnce(spec.id)

      expect(verdict.kind).toBe("ok")
      expect(tank.published).toEqual([{ taskId: spec.id, cwd: "/work/cwd", files: [] }])
    }).pipe(Effect.provide(leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS)), tank })))
  })

  it.effect("a failed publication is reported as an error and does not change the verdict", () => {
    const tank = makeFakeTank({ failPublish: true })
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot))
      const verdict = yield* lead.runOnce(spec.id)

      expect(verdict.kind).toBe("ok")
      const errors = Array.from(yield* allEvents).filter((event) => event.type === "error.raised")
      const wheres = errors.map((event) => Schema.decodeUnknownSync(ErrorPayload)(event.payload).where)
      expect(wheres).toContain("lead.artifacts")
    }).pipe(Effect.provide(leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS)), tank })))
  })
})
