import { it } from "@effect/vitest"
import { Beacon, type BeaconShape } from "@shoalwork/beacon"
import { BotRegistry } from "@shoalwork/bots"
import { newPlanId, newStepId, newTaskId, streamIds, type TaskId } from "@shoalwork/contracts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { startNarrator } from "../src/narrate.js"
import { makeTaskStore } from "../src/tasks.js"
import { makeFakeTelegramOut } from "./conversation-support.js"
import { PodLayer } from "./pods-support.js"
import { NEW_BOT, specFor } from "./support.js"

// The Pod narrates a plan's steps; the Bot's topic must not get them a second time.
describe("narration of plan steps", () => {
  it.live("a plan step is narrated only in its Pod, a loose task in its Bot's topic", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const beacon = yield* Beacon
      const bots = yield* BotRegistry
      const tasks = makeTaskStore(sql)
      const bot = yield* bots.upsert(NEW_BOT, "test")
      const telegram = makeFakeTelegramOut()
      const planStep = {
        ...specFor(bot, { parent: { planId: newPlanId(), stepId: newStepId() } }),
        id: newTaskId(),
      }
      const loose = { ...specFor(bot), id: newTaskId() }
      yield* tasks.insert(planStep)
      yield* tasks.insert(loose)
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* startNarrator({
            beacon,
            tasks,
            telegram: telegram.shape,
            languageOf: () => "pt",
            forget: () => {},
            summarize: (summary) => Effect.succeed(summary),
          })
          for (const taskId of [planStep.id, loose.id]) {
            yield* transition(beacon, taskId)
          }
          for (let attempt = 0; attempt < 200 && telegram.sent.length < 1; attempt += 1) {
            yield* Effect.sleep("10 millis")
          }
          yield* Effect.sleep("50 millis")
        }),
      )
      expect(telegram.sent).toHaveLength(1)
      expect(telegram.sent[0]?.botId).toBe(bot.id)
    }).pipe(Effect.provide(PodLayer)),
  )
})

const transition = (beacon: BeaconShape, taskId: TaskId) =>
  beacon.append({
    streamId: streamIds.task(taskId),
    type: "task.state_changed",
    payload: { taskId, from: "verifying", to: "done" },
    actor: "test",
    correlationId: "corr-narrate",
  })
