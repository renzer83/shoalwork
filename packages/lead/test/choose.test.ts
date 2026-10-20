import { it } from "@effect/vitest"
import { BotRegistry } from "@shoalwork/bots"
import { type ExecutorId, NewBot } from "@shoalwork/contracts"
import type { Executor } from "@shoalwork/executors"
import { Effect, Schema, Stream } from "effect"
import { describe, expect } from "vitest"
import {
  allEvents,
  CLAUDE,
  CODEX,
  eventTypes,
  Lead,
  leadLayer,
  OK_EVENTS,
  type Runs,
  specFor,
} from "./support.js"

// A fake executor with a chosen id and availability; every task it is asked to run is recorded in `runs`.
const fakeNamed = (id: ExecutorId, runs: Runs, available = true): Executor => ({
  id,
  run: (task) => {
    runs.push(task)
    return Stream.fromIterable(OK_EVENTS)
  },
  mapTier: () => ({ model: `${id}-model` }),
  quota: () => Effect.succeed({ executor: id, usedRatio: 0, available }),
})

const unavailable = (executor: Executor): Executor => ({
  ...executor,
  quota: () => Effect.succeed({ executor: executor.id, usedRatio: 1, available: false }),
})

// A Bot whose modelTiers override is the only thing that differs from the default test Bot.
const botWithTiers = (
  name: string,
  modelTiers: Record<string, unknown>,
  allowed = ["claude-code", "codex"],
) =>
  Effect.gen(function* () {
    const registry = yield* BotRegistry
    const newBot = Schema.decodeUnknownSync(NewBot)({
      name,
      role: "developer",
      kind: "auxiliary",
      instructions: "Do the work you are given.",
      executors: { preferred: "claude-code", allowed },
      modelTiers,
      connectors: [],
      budget: { tokens: 500000, seconds: 1800, usd: 5 },
      policy: "default",
      tank: { mode: "local", host: "mac" },
      memory: { scope: "bot" },
    })
    return yield* registry.upsert(newBot, "test")
  })

describe("executor choice by tier", () => {
  it.effect("a Bot override of the tier decides the executor, not the Bot's preferred one", () => {
    const claudeRuns: Runs = []
    const codexRuns: Runs = []
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* botWithTiers("override-bot", {
        light: { executor: "codex", model: "gpt-override" },
      })
      const spec = yield* lead.intake(specFor(bot, { tier: "light" }))
      const verdict = yield* lead.runOnce(spec.id)

      expect(verdict.kind).toBe("ok")
      expect(claudeRuns).toHaveLength(0)
      expect(codexRuns).toHaveLength(1)
      const started = (yield* allEvents).find((event) => event.type === "executor.started")
      expect(started?.payload).toMatchObject({ executor: "codex" })
    }).pipe(
      Effect.provide(
        leadLayer({
          executor: fakeNamed(CLAUDE, claudeRuns),
          extra: [fakeNamed(CODEX, codexRuns)],
        }),
      ),
    )
  })

  it.effect("an unavailable executor of the tier falls back to the first available alternative", () => {
    const claudeRuns: Runs = []
    const codexRuns: Runs = []
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* botWithTiers("fallback-bot", {})
      const spec = yield* lead.intake(specFor(bot, { tier: "heavy" }))
      const verdict = yield* lead.runOnce(spec.id)

      expect(verdict.kind).toBe("ok")
      expect(claudeRuns).toHaveLength(0)
      expect(codexRuns).toHaveLength(1)
      const started = (yield* allEvents).find((event) => event.type === "executor.started")
      expect(started?.payload).toMatchObject({ executor: "codex" })
    }).pipe(
      Effect.provide(
        leadLayer({
          executor: unavailable(fakeNamed(CLAUDE, claudeRuns)),
          extra: [fakeNamed(CODEX, codexRuns)],
        }),
      ),
    )
  })

  it.effect("no available executor for the tier is a blocked verdict and nothing runs", () => {
    const claudeRuns: Runs = []
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* botWithTiers("nobody-bot", {})
      const spec = yield* lead.intake(specFor(bot, { tier: "heavy" }))
      const verdict = yield* lead.runOnce(spec.id)

      expect(verdict).toMatchObject({
        kind: "blocked",
        evidence: ["no executor available for tier heavy"],
      })
      expect(claudeRuns).toHaveLength(0)
      expect((yield* lead.get(spec.id)).state).toBe("failed")
      expect(yield* eventTypes).not.toContain("executor.started")
      expect(yield* eventTypes).toContain("executor.finished")
    }).pipe(
      Effect.provide(
        leadLayer({
          executor: unavailable(fakeNamed(CLAUDE, claudeRuns)),
        }),
      ),
    )
  })
  it.effect("a tier executor outside the Bot's allowed list falls back to an allowed alternative", () => {
    const claudeRuns: Runs = []
    const codexRuns: Runs = []
    return Effect.gen(function* () {
      const lead = yield* Lead
      // claude-code is available but the Bot is not allowed to use it: heavy must go to its alternative, codex.
      const bot = yield* botWithTiers("policy-bot", {}, ["codex"])
      const spec = yield* lead.intake(specFor(bot, { tier: "heavy" }))
      const verdict = yield* lead.runOnce(spec.id)

      expect(verdict.kind).toBe("ok")
      expect(claudeRuns).toHaveLength(0)
      expect(codexRuns).toHaveLength(1)
    }).pipe(
      Effect.provide(
        leadLayer({
          executor: fakeNamed(CLAUDE, claudeRuns),
          extra: [fakeNamed(CODEX, codexRuns)],
        }),
      ),
    )
  })

  it.effect("a tier whose executors are all outside the Bot's allowed list is a blocked verdict", () => {
    const claudeRuns: Runs = []
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* botWithTiers("locked-bot", {}, ["codex"])
      const spec = yield* lead.intake(specFor(bot, { tier: "light" }))
      const verdict = yield* lead.runOnce(spec.id)

      expect(verdict).toMatchObject({ kind: "blocked", evidence: ["no executor available for tier light"] })
      expect(claudeRuns).toHaveLength(0)
    }).pipe(Effect.provide(leadLayer({ executor: fakeNamed(CLAUDE, claudeRuns) })))
  })

  it.effect("a Bot override of model and effort reaches the task and executor.started", () => {
    const claudeRuns: Runs = []
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* botWithTiers("model-bot", {
        light: { executor: "claude-code", model: "claude-override-5", effort: "low" },
      })
      const spec = yield* lead.intake(specFor(bot, { tier: "light" }))
      yield* lead.runOnce(spec.id)

      expect(claudeRuns).toHaveLength(1)
      expect(claudeRuns[0]).toMatchObject({ model: "claude-override-5", effort: "low" })
      const started = (yield* allEvents).find((event) => event.type === "executor.started")
      expect(started?.payload).toMatchObject({ executor: "claude-code", model: "claude-override-5" })
    }).pipe(Effect.provide(leadLayer({ executor: fakeNamed(CLAUDE, claudeRuns) })))
  })

  it.effect("a fallback alternative runs with its own model, not the primary's", () => {
    const codexRuns: Runs = []
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* botWithTiers("alt-model-bot", {})
      const spec = yield* lead.intake(specFor(bot, { tier: "heavy" }))
      yield* lead.runOnce(spec.id)

      expect(codexRuns[0]?.model).toBe("codex-model")
      expect(codexRuns[0]?.effort).toBeUndefined()
      const started = (yield* allEvents).find((event) => event.type === "executor.started")
      expect(started?.payload).toMatchObject({ executor: "codex", model: "codex-model" })
    }).pipe(
      Effect.provide(
        leadLayer({
          executor: unavailable(fakeNamed(CLAUDE, [])),
          extra: [fakeNamed(CODEX, codexRuns)],
        }),
      ),
    )
  })
})
