import { it } from "@effect/vitest"
import { BotRegistry } from "@shoalwork/bots"
import { EventPayloads, ExecutorId, NewBot } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import {
  allEvents,
  eventsOf,
  fakeExecutor,
  Lead,
  leadLayer,
  OK_EVENTS,
  type Runs,
  specFor,
} from "./support.js"

// A Bot that may use both executors: claude-code (the heavy tier's primary) and codex (its alternative).
const RANKED_BOT = Schema.decodeUnknownSync(NewBot)({
  name: "ranked-bot",
  role: "developer",
  kind: "auxiliary",
  instructions: "Do the work you are given.",
  executors: { preferred: "claude-code", allowed: ["claude-code", "codex"] },
  modelTiers: {},
  connectors: [],
  budget: { tokens: 500000, seconds: 1800, usd: 5 },
  policy: "default",
  tank: { mode: "local", host: "mac" },
  memory: { scope: "bot" },
})

// Per-executor history for the code kind: [executor, runs, ok runs]. Both are 10 runs, so both are past the prior.
const seedHistory = (rows: ReadonlyArray<readonly [string, number, number]>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    for (const [executor, n, ok] of rows) {
      yield* sql`INSERT INTO executor_quality (executor, kind, window_days, n, ok_rate, retry_rate, avg_usd, avg_seconds, computed_at)
        VALUES (${executor}, 'code', 30, ${n}, ${ok / n}, 0, 0, 1, '2026-10-21T10:00:00.000Z')`
    }
  })

// Runs one code task of the heavy tier through the real Lead, with both executors registered.
const runWith = (history: ReadonlyArray<readonly [string, number, number]>) => {
  const claudeRuns: Runs = []
  const codexRuns: Runs = []
  const claude = fakeExecutor(eventsOf(OK_EVENTS), claudeRuns)
  const codex = {
    ...fakeExecutor(eventsOf(OK_EVENTS), codexRuns),
    id: Schema.decodeUnknownSync(ExecutorId)("codex"),
  }
  return Effect.gen(function* () {
    yield* seedHistory(history)
    const bots = yield* BotRegistry
    const bot = yield* bots.upsert(RANKED_BOT, "test")
    const lead = yield* Lead
    const spec = yield* lead.intake(specFor(bot, { tier: "heavy" }))
    const verdict = yield* lead.runOnce(spec.id)
    const decisions = (yield* allEvents).filter((event) => event.type === "decision.made")
    const executorChoice = decisions
      .map((event) => ({
        event,
        payload: Schema.decodeUnknownSync(EventPayloads["decision.made"])(event.payload),
      }))
      .find((entry) => entry.payload.questionId === "executor")
    return {
      verdict,
      specId: spec.id,
      claudeRuns: claudeRuns.length,
      codexRuns: codexRuns.length,
      executorChoice,
    }
  }).pipe(Effect.provide(leadLayer({ executor: claude, extra: [codex] })))
}

describe("a real run picks its executor by the ranking", () => {
  it.effect("runs the alternative with the better history and records the choice with its reasons", () =>
    Effect.gen(function* () {
      const run = yield* runWith([
        ["claude-code", 10, 1],
        ["codex", 10, 9],
      ])
      // 1/10 ok for claude-code against 9/10 for codex: the alternative wins the score.
      expect(run.verdict.kind).toBe("ok")
      expect(run.codexRuns).toBe(1)
      expect(run.claudeRuns).toBe(0)
      expect(run.executorChoice?.payload).toMatchObject({
        questionId: "executor",
        kind: "choice",
        value: "codex",
        source: "rule",
        facts: { kind: "code", tier: "heavy", reasons: [] },
      })
      // The choice is recorded under the task's correlation, so its outcome closes with the task.
      expect(run.executorChoice?.event.correlationId).toBe(run.specId)
    }),
  )

  it.effect("keeps the tier's executor when its history is the better one", () =>
    Effect.gen(function* () {
      const run = yield* runWith([
        ["claude-code", 10, 9],
        ["codex", 10, 1],
      ])
      expect(run.claudeRuns).toBe(1)
      expect(run.codexRuns).toBe(0)
      expect(run.executorChoice?.payload).toMatchObject({ value: "claude-code", source: "rule" })
    }),
  )
})
