import { it } from "@effect/vitest"
import { Beacon } from "@shoalwork/beacon"
import { BotRegistry } from "@shoalwork/bots"
import {
  type ExecutorEvent,
  NewBot,
  newTaskId,
  streamIds,
  type Usage,
  ZERO_USAGE,
} from "@shoalwork/contracts"
import { Duration, Effect, Option, Schema, Stream } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { breachOf, watchBudgets } from "../src/budget.js"
import { botBudgetPhrase, budgetPhrase } from "../src/narrator.js"
import {
  allEvents,
  createBot,
  eventsOf,
  eventTypes,
  fakeExecutor,
  Lead,
  leadLayer,
  makeFakeTank,
  specFor,
} from "./support.js"

const usage = (tokensIn: number): Usage => ({ ...ZERO_USAGE, tokensIn })
const usageEvent = (tokensIn: number): ExecutorEvent => ({ kind: "usage", usage: usage(tokensIn) })

// The run emits these events, then waits: only a budget breach or a stop can end it.
const thenWaits = (events: ReadonlyArray<ExecutorEvent>) =>
  Stream.concat(Stream.fromIterable(events), Stream.fromEffect(Effect.never))

const TIGHT_BOT = Schema.decodeUnknownSync(NewBot)({
  name: "tight-bot",
  role: "developer",
  kind: "auxiliary",
  instructions: "Do the work you are given.",
  executors: { preferred: "claude-code", allowed: ["claude-code"] },
  modelTiers: {},
  connectors: [],
  budget: { tokens: 150000, seconds: 1800, usd: 5 },
  policy: "default",
  tank: { mode: "local", host: "mac" },
  memory: { scope: "bot" },
})

const count = (types: ReadonlyArray<string>, type: string) => types.filter((t) => t === type).length

describe("breachOf", () => {
  const limit = { tokens: 300, seconds: 600, usd: 1 }
  it("does not breach at the exact limit and breaches one token past it", () => {
    expect(breachOf({ limit, used: usage(300) }, { limit, used: usage(0) })).toBeUndefined()
    expect(breachOf({ limit, used: usage(301) }, { limit, used: usage(0) })).toEqual({
      scope: "task",
      limit,
      used: { tokens: 301, seconds: 0, usd: 0 },
    })
  })

  it("names the Bot when only the Bot's window is over", () => {
    expect(breachOf({ limit, used: usage(10) }, { limit, used: usage(400) })?.scope).toBe("bot")
  })
})

describe("watchBudgets", () => {
  it.live("cuts the round when the task's usage passes its limit, not before", () =>
    Effect.gen(function* () {
      const beacon = yield* Beacon
      const bots = yield* BotRegistry
      const bot = yield* bots.upsert(TIGHT_BOT, "test")
      const spec = { budget: { tokens: 300, seconds: 600, usd: 1 } }
      const watch = yield* watchBudgets({ beacon, bot, spec, carry: undefined, windowMs: 3_600_000 })
      yield* watch.observe(usage(100))
      yield* watch.observe(usage(100))
      expect(Option.isNone(yield* watch.breached.pipe(Effect.timeoutOption(Duration.millis(20))))).toBe(true)
      yield* watch.observe(usage(100))
      expect(Option.isNone(yield* watch.breached.pipe(Effect.timeoutOption(Duration.millis(20))))).toBe(true)
      yield* watch.observe(usage(1))
      expect(yield* watch.breached).toMatchObject({ scope: "task", used: { tokens: 301 } })
    }).pipe(Effect.provide(leadLayer({ executor: fakeExecutor(eventsOf([])) }))),
  )
})

describe("budget enforcement in the runner", () => {
  it.live(
    "a task is cut at the first usage event past its limit, with one budget.exceeded and one executor.finished",
    () => {
      const tank = makeFakeTank()
      return Effect.gen(function* () {
        const lead = yield* Lead
        const bot = yield* createBot
        // Limit 100000 tokens: 100000 exactly is still within it, the third event (150000) is past it.
        const spec = yield* lead.intake(specFor(bot, { budget: { tokens: 100000, seconds: 60, usd: 1 } }))
        const verdict = yield* lead.runOnce(spec.id)

        expect(verdict).toMatchObject({ kind: "budget_exceeded", summary: "task budget exceeded" })
        expect((yield* lead.get(spec.id)).state).toBe("failed")
        const types = yield* eventTypes
        expect(count(types, "usage.recorded")).toBe(3)
        expect(count(types, "budget.exceeded")).toBe(1)
        expect(count(types, "executor.finished")).toBe(1)
        const events = yield* allEvents
        expect(events.find((e) => e.type === "budget.exceeded")?.payload).toMatchObject({
          scope: "task",
          refId: spec.id,
        })
        expect(tank.released).toEqual([{ keepWorktree: true }])
      }).pipe(
        Effect.provide(
          leadLayer({
            tank,
            executor: fakeExecutor(() =>
              thenWaits([usageEvent(50000), usageEvent(50000), usageEvent(50000)]),
            ),
          }),
        ),
      )
    },
  )

  it.live("a Bot past its window pauses after the run is cut, and a second task is refused", () =>
    Effect.gen(function* () {
      const lead = yield* Lead
      const bots = yield* BotRegistry
      const bot = yield* bots.upsert(TIGHT_BOT, "test")
      const spec = yield* lead.intake(specFor(bot, { budget: { tokens: 1000000, seconds: 60, usd: 1 } }))
      const verdict = yield* lead.runOnce(spec.id)

      expect(verdict.kind).toBe("budget_exceeded")
      const events = yield* allEvents
      expect(events.find((e) => e.type === "budget.exceeded")?.payload).toMatchObject({
        scope: "bot",
        refId: bot.id,
        limit: { tokens: 150000 },
      })
      expect(
        count(
          events.map((e) => e.type),
          "executor.finished",
        ),
      ).toBe(1)
      expect(events.find((e) => e.type === "control.changed")?.payload).toMatchObject({
        action: "pause",
        by: "system:budget",
      })
      expect((yield* bots.list()).find((b) => b.id === bot.id)?.state).toBe("paused")

      // The window still holds the spent usage: the next task is refused at intake, and no second run starts.
      const next = yield* lead.intake(specFor(bot))
      expect((yield* lead.get(next.id)).state).toBe("failed")
      expect((yield* lead.get(next.id)).verdict?.kind).toBe("budget_exceeded")
      expect(count(yield* eventTypes, "executor.started")).toBe(1)
    }).pipe(
      Effect.provide(
        leadLayer({
          executor: fakeExecutor(() => thenWaits([usageEvent(80000), usageEvent(80000)])),
        }),
      ),
    ),
  )

  it.live(
    "intake refuses a task for a Bot already over its window: failed with reason budget, nothing queued",
    () =>
      Effect.gen(function* () {
        const beacon = yield* Beacon
        const sql = yield* SqlClient
        const bots = yield* BotRegistry
        const bot = yield* bots.upsert(TIGHT_BOT, "test")
        const taskId = newTaskId()
        yield* beacon.append({
          streamId: streamIds.task(taskId),
          type: "usage.recorded",
          payload: { taskId, botId: bot.id, executor: "claude-code", model: "fake", usage: usage(200000) },
          actor: "system:test",
          correlationId: taskId,
        })
        const lead = yield* Lead
        const spec = yield* lead.intake(specFor(bot))

        const stored = yield* lead.get(spec.id)
        expect(stored.state).toBe("failed")
        expect(stored.verdict?.kind).toBe("budget_exceeded")
        const types = yield* eventTypes
        expect(count(types, "executor.started")).toBe(0)
        expect(count(types, "budget.exceeded")).toBe(1)
        expect(yield* sql`SELECT COUNT(*) AS n FROM jobs WHERE queue = 'tasks'`).toEqual([{ n: 0 }])
      }).pipe(Effect.provide(leadLayer({ executor: fakeExecutor(eventsOf([])) }))),
  )
})

describe("budget phrases", () => {
  it("say the Bot's budget and the task's budget apart in every language", () => {
    expect(botBudgetPhrase("pt")).toContain("Orçamento do Bot estourado")
    expect(botBudgetPhrase("en")).toContain("The Bot's budget ran out")
    expect(botBudgetPhrase("es")).toContain("presupuesto del Bot")
    expect(botBudgetPhrase("pt")).not.toBe(budgetPhrase("pt"))
  })
})
