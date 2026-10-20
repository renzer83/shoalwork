import { it } from "@effect/vitest"
import { Beacon } from "@shoalwork/beacon"
import { BotRegistry } from "@shoalwork/bots"
import { streamIds, type TaskId } from "@shoalwork/contracts"
import { Duration, Effect, Stream } from "effect"
import { describe, expect } from "vitest"
import { okVerdict } from "./plan/dispatch-support.js"
import { createBot, eventsOf, fakeExecutor, Lead, leadLayer, NEW_BOT, OK_EVENTS, specFor } from "./support.js"

const FAST = { heartbeatMs: 20, reapEveryMs: 20, staleSeconds: 60 } as const

describe("Lead.startWorker with a run of its own", () => {
  it.live("runs the claimed jobs through it and reports a settled child to its parent", () =>
    Effect.gen(function* () {
      const lead = yield* Lead
      const beacon = yield* Beacon
      const worker = yield* createBot
      const reviewer = yield* (yield* BotRegistry).upsert({ ...NEW_BOT, name: "reviewer-bot" }, "test")
      const parent = yield* lead.intake(specFor(worker))
      const outcome = yield* lead.handoff(
        worker.id,
        reviewer.id,
        {
          parentTaskId: parent.id,
          title: "Review the change",
          prompt: "Review it.",
          kind: "code",
          acceptance: ["reviewed"],
        },
        { tokens: 1000, seconds: 30, usd: 0.5 },
      )
      if (outcome._tag !== "Created") throw new Error("handoff refused")
      const ran: Array<TaskId> = []
      const results = Effect.gen(function* () {
        const events = yield* Stream.runCollect(beacon.readStream(streamIds.task(parent.id)))
        return events.filter(
          (event) => event.type === "agent.msg" && JSON.stringify(event.payload).includes('"result"'),
        )
      })
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* lead.startWorker({
            concurrency: 2,
            pollMs: 10,
            runTask: (id) =>
              Effect.sync(() => {
                ran.push(id)
                return { verdict: okVerdict(), recorded: true, stopped: false }
              }),
          })
          while ((yield* results).length === 0) yield* Effect.sleep(Duration.millis(10))
        }),
      )
      expect(ran).toContain(outcome.child.id)
      expect(yield* results).toHaveLength(1)
    }).pipe(Effect.provide(leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS)), config: FAST }))),
  )
})
