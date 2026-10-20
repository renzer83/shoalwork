import { it } from "@effect/vitest"
import { Duration, Effect, Redacted } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { describe, expect } from "vitest"
import { ApprovalFlow, McpTokens } from "../src/index.js"
import { approvalLayer, DONE, jobsOf, STARTED, scripted, TWO_HOURS } from "./approval-support.js"
import { allEvents, createBot, Lead, specFor } from "./support.js"

const PUSH = { tool: "Bash", input: { command: "git push" } } as const

// A task whose CLI is running: the state the bridge finds it in.
const runningTask = Effect.gen(function* () {
  const lead = yield* Lead
  const bot = yield* createBot
  const spec = yield* lead.intake(specFor(bot, { kind: "chat" }))
  const sql = yield* SqlClient
  yield* sql`UPDATE tasks SET state = 'running' WHERE id = ${spec.id}`
  return { lead, bot, spec }
})

const layer = approvalLayer(scripted([[STARTED, DONE]], []))

describe("inline approvals", () => {
  it.effect("ask moves running to waiting_approval, a decision moves it back, and nothing is queued", () =>
    Effect.gen(function* () {
      const { lead, bot, spec } = yield* runningTask
      const flow = yield* ApprovalFlow
      const jobs = yield* jobsOf(spec.id)
      const asked = yield* flow.requestInline({
        taskId: spec.id,
        botId: bot.id,
        action: PUSH,
        risk: "external",
      })
      expect(asked.mode).toBe("inline")
      expect((yield* lead.get(spec.id)).state).toBe("waiting_approval")
      const decided = yield* flow.decide(asked.id, "approved", "user:web")
      expect(decided._tag).toBe("Resolved")
      expect((yield* lead.get(spec.id)).state).toBe("running")
      expect(yield* jobsOf(spec.id)).toBe(jobs)
      // A second click only reads what was decided.
      expect((yield* flow.decide(asked.id, "denied", "user:cli"))._tag).toBe("AlreadyResolved")
      expect((yield* lead.get(spec.id)).state).toBe("running")
      const requested = (yield* allEvents).find((event) => event.type === "approval.requested")
      expect(requested?.payload).toMatchObject({ mode: "inline" })
    }).pipe(Effect.provide(layer)),
  )

  it.effect("a denial also gives the task back to the run that is waiting", () =>
    Effect.gen(function* () {
      const { lead, bot, spec } = yield* runningTask
      const flow = yield* ApprovalFlow
      const asked = yield* flow.requestInline({
        taskId: spec.id,
        botId: bot.id,
        action: PUSH,
        risk: "external",
      })
      yield* flow.decide(asked.id, "denied", "user:web")
      expect((yield* lead.get(spec.id)).state).toBe("running")
    }).pipe(Effect.provide(layer)),
  )

  it.effect("an expired inline request does not close the task: the run reads the denial and goes on", () =>
    Effect.gen(function* () {
      const { lead, bot, spec } = yield* runningTask
      const flow = yield* ApprovalFlow
      yield* flow.requestInline({ taskId: spec.id, botId: bot.id, action: PUSH, risk: "external" })
      yield* TestClock.adjust(Duration.millis(TWO_HOURS + 1000))
      expect(yield* flow.expireDue()).toBe(1)
      expect((yield* lead.get(spec.id)).state).toBe("running")
    }).pipe(Effect.provide(layer)),
  )

  it.effect("a bridge token carries its mode and the worktree bound to it", () =>
    Effect.gen(function* () {
      const { bot, spec } = yield* runningTask
      const tokens = yield* McpTokens
      const issued = yield* tokens.issue({
        botId: bot.id,
        repo: "shoalwork",
        taskId: spec.id,
        ttl: 60_000,
        bridgeMode: "inline",
      })
      const raw = Redacted.value(issued.token)
      expect(yield* tokens.verify(raw)).toEqual({
        botId: bot.id,
        repo: "shoalwork",
        taskId: spec.id,
        bridgeMode: "inline",
      })
      yield* tokens.bindWorkspace(spec.id, "/work/tree")
      expect(yield* tokens.verify(raw)).toMatchObject({ cwd: "/work/tree", bridgeMode: "inline" })
    }).pipe(Effect.provide(layer)),
  )
})
