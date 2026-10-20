import { it } from "@effect/vitest"
import { Beacon } from "@shoalwork/beacon"
import { BotRegistry } from "@shoalwork/bots"
import { Approvals } from "@shoalwork/policy"
import { Duration, Effect, Fiber, Option, Ref } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { describe, expect } from "vitest"
import { makeApprovalRunner } from "../src/approval-request.js"
import { ApprovalFlow, Control, TaskStore, taskTarget } from "../src/index.js"
import { makeLifecycle } from "../src/lifecycle.js"
import { raceWithStop } from "../src/stoppable.js"
import { INITIAL, type Progress } from "../src/verdict.js"
import { approvalLayer, DONE, STARTED, scripted } from "./approval-support.js"
import { createBot, Lead, makeFakeTank, specFor } from "./support.js"

const PUSH = { tool: "Bash", input: { command: "git push" } } as const
const ASKED = { risk: "external", action: PUSH } as const

const runningTask = Effect.gen(function* () {
  const lead = yield* Lead
  const bot = yield* createBot
  const spec = yield* lead.intake(specFor(bot, { kind: "chat" }))
  const sql = yield* SqlClient
  yield* sql`UPDATE tasks SET state = 'running' WHERE id = ${spec.id}`
  return { lead, bot, spec }
})

const layer = approvalLayer(scripted([[STARTED, DONE]], []))

describe("inline approvals, edges", () => {
  it.effect("a late answer to an old request does not release a task waiting for a newer one", () =>
    Effect.gen(function* () {
      const { lead, bot, spec } = yield* runningTask
      const flow = yield* ApprovalFlow
      const first = yield* flow.requestInline({ taskId: spec.id, botId: bot.id, ...ASKED })
      yield* flow.decide(first.id, "approved", "user:web")
      const second = yield* flow.requestInline({
        taskId: spec.id,
        botId: bot.id,
        risk: "external",
        action: { tool: "Bash", input: { command: "git push --tags" } },
      })
      expect(second.id).not.toBe(first.id)
      expect((yield* lead.get(spec.id)).state).toBe("waiting_approval")
      // The old request is clicked again, out of order: still waiting for the new one.
      expect((yield* flow.decide(first.id, "denied", "user:cli"))._tag).toBe("AlreadyResolved")
      expect((yield* lead.get(spec.id)).state).toBe("waiting_approval")
      yield* flow.decide(second.id, "denied", "user:web")
      expect((yield* lead.get(spec.id)).state).toBe("running")
    }).pipe(Effect.provide(layer)),
  )

  it.effect("a new ask during the pause returns the open request and changes nothing", () =>
    Effect.gen(function* () {
      const { lead, bot, spec } = yield* runningTask
      const flow = yield* ApprovalFlow
      const first = yield* flow.requestInline({ taskId: spec.id, botId: bot.id, ...ASKED })
      const again = yield* flow.requestInline({ taskId: spec.id, botId: bot.id, ...ASKED })
      expect(again.id).toBe(first.id)
      expect((yield* lead.get(spec.id)).state).toBe("waiting_approval")
      expect((yield* (yield* Approvals).listPending()).length).toBe(1)
    }).pipe(Effect.provide(layer)),
  )

  it.effect("a decision on a task that was cancelled meanwhile does not bring it back to life", () =>
    Effect.gen(function* () {
      const { lead, bot, spec } = yield* runningTask
      const flow = yield* ApprovalFlow
      const asked = yield* flow.requestInline({ taskId: spec.id, botId: bot.id, ...ASKED })
      const sql = yield* SqlClient
      yield* sql`UPDATE tasks SET state = 'cancelled' WHERE id = ${spec.id}`
      expect((yield* flow.decide(asked.id, "approved", "user:web"))._tag).toBe("Resolved")
      expect((yield* lead.get(spec.id)).state).toBe("cancelled")
    }).pipe(Effect.provide(layer)),
  )

  it.effect("a stop while the CLI waits ends the request and the task", () =>
    Effect.gen(function* () {
      const { lead, bot, spec } = yield* runningTask
      const flow = yield* ApprovalFlow
      const asked = yield* flow.requestInline({ taskId: spec.id, botId: bot.id, ...ASKED })
      yield* (yield* Control).stop(taskTarget(spec.id), "user:test")
      expect((yield* (yield* Approvals).get(asked.id)).status).toBe("expired")
      expect((yield* lead.get(spec.id)).state).toBe("cancelled")
    }).pipe(Effect.provide(layer)),
  )

  it.effect("the end of a run expires its inline requests and leaves the task running", () =>
    Effect.gen(function* () {
      const { lead, bot, spec } = yield* runningTask
      const flow = yield* ApprovalFlow
      const approvals = yield* Approvals
      const beacon = yield* Beacon
      const tasks = yield* TaskStore
      const bots = yield* BotRegistry
      const lifecycle = makeLifecycle({ beacon, tasks, bots })
      const runner = makeApprovalRunner({
        approvals,
        sql: yield* SqlClient,
        beacon,
        tank: makeFakeTank().shape,
        bots,
        lifecycle,
      })
      const asked = yield* flow.requestInline({ taskId: spec.id, botId: bot.id, ...ASKED })
      expect((yield* lead.get(spec.id)).state).toBe("waiting_approval")
      yield* runner.endInline(spec)
      const ended = yield* approvals.get(asked.id)
      expect(ended).toMatchObject({ status: "expired", resolvedBy: "system:run-ended" })
      expect((yield* lead.get(spec.id)).state).toBe("running")
      expect(Option.isSome(yield* approvals.latestForTask(spec.id))).toBe(true)
    }).pipe(Effect.provide(layer)),
  )
})

describe("time budget and inline waits", () => {
  const handle = { stopRequested: Effect.never, isStopped: Effect.succeed(false) }

  it.effect("the deadline moves out by the time spent waiting for a person", () =>
    Effect.gen(function* () {
      const progress = yield* Ref.make<Progress>(INITIAL)
      let waitedMs = 0
      const fiber = yield* Effect.forkChild(
        raceWithStop(Effect.never, handle, 1000, progress, Effect.never, () => Effect.sync(() => waitedMs)),
      )
      yield* TestClock.adjust(Duration.millis(500))
      waitedMs = 3000
      yield* TestClock.adjust(Duration.millis(600))
      expect(fiber.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust(Duration.millis(2900))
      expect(Option.isNone(yield* Fiber.join(fiber))).toBe(true)
      expect((yield* Ref.get(progress)).outcome._tag).toBe("TimedOut")
    }),
  )

  it.effect("without waits the budget is the plain time limit", () =>
    Effect.gen(function* () {
      const progress = yield* Ref.make<Progress>(INITIAL)
      const fiber = yield* Effect.forkChild(
        raceWithStop(Effect.never, handle, 1000, progress, Effect.never, () => Effect.succeed(0)),
      )
      yield* TestClock.adjust(Duration.millis(999))
      expect(fiber.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust(Duration.millis(1))
      expect(Option.isNone(yield* Fiber.join(fiber))).toBe(true)
    }),
  )
})
