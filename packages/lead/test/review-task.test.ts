import { it } from "@effect/vitest"
import { BotRegistry } from "@shoalwork/bots"
import { type ExecutorId, NewBot, newPlanId, newStepId } from "@shoalwork/contracts"
import type { Executor } from "@shoalwork/executors"
import { Effect, Schema, Stream } from "effect"
import { describe, expect } from "vitest"
import {
  allEvents,
  CLAUDE,
  CODEX,
  createBot,
  HEALTHY_EXEC,
  Lead,
  leadLayer,
  makeFakeTank,
  OK_EVENTS,
  type Runs,
  specFor,
} from "./support.js"

const REPO = { url: "https://github.com/renzer83/shoalwork-sandbox", base: "main" } as const

const named = (id: ExecutorId, runs: Runs): Executor => ({
  id,
  run: (task) => {
    runs.push(task)
    return Stream.fromIterable(OK_EVENTS)
  },
  mapTier: () => ({ model: `${id}-model` }),
  quota: () => Effect.succeed({ executor: id, usedRatio: 0, available: true }),
})

// A Bot allowed to use both executors: only the exclusion can keep a task off one of them.
const bothAllowed = Effect.gen(function* () {
  const registry = yield* BotRegistry
  const newBot = Schema.decodeUnknownSync(NewBot)({
    name: "reviewer-bot",
    role: "reviewer",
    kind: "auxiliary",
    instructions: "Review the work you are given.",
    executors: { preferred: "claude-code", allowed: ["claude-code", "codex"] },
    modelTiers: {},
    connectors: [],
    budget: { tokens: 500000, seconds: 1800, usd: 5 },
    policy: "default",
    tank: { mode: "local", host: "mac" },
    memory: { scope: "bot" },
  })
  return yield* registry.upsert(newBot, "test")
})

const parent = () => ({ planId: newPlanId(), stepId: newStepId() })

describe("a review task", () => {
  it.effect(
    "never runs on an executor of its exclusion list, even when it is the tier's first choice",
    () => {
      const claudeRuns: Runs = []
      const codexRuns: Runs = []
      return Effect.gen(function* () {
        const lead = yield* Lead
        const bot = yield* bothAllowed
        const spec = yield* lead.intake(
          specFor(bot, { tier: "heavy", review: { excludeExecutors: [CLAUDE] } }),
        )
        const verdict = yield* lead.runOnce(spec.id)
        expect(verdict.kind).toBe("ok")
        expect(claudeRuns).toHaveLength(0)
        expect(codexRuns).toHaveLength(1)
        const started = (yield* allEvents).find((event) => event.type === "executor.started")
        expect(started?.payload).toMatchObject({ executor: "codex" })
      }).pipe(
        Effect.provide(
          leadLayer({
            executor: named(CLAUDE, claudeRuns),
            extra: [named(CODEX, codexRuns)],
          }),
        ),
      )
    },
  )

  it.effect("with no executor left it is blocked, not run on the excluded one", () => {
    const claudeRuns: Runs = []
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot, { tier: "heavy", review: { excludeExecutors: [CLAUDE] } }))
      const verdict = yield* lead.runOnce(spec.id)
      expect(verdict).toMatchObject({ kind: "blocked", evidence: ["no executor available for tier heavy"] })
      expect(claudeRuns).toHaveLength(0)
    }).pipe(Effect.provide(leadLayer({ executor: named(CLAUDE, claudeRuns) })))
  })

  it.effect("delivers nothing: no commit, no push, no PR, and a clean review is ok", () => {
    const tank = makeFakeTank({ exec: HEALTHY_EXEC })
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(
        specFor(bot, { repo: REPO, parent: parent(), review: { excludeExecutors: [] } }),
      )
      const verdict = yield* lead.runOnce(spec.id)
      expect(verdict.kind).toBe("ok")
      expect(tank.commands).toEqual([])
    }).pipe(Effect.provide(leadLayer({ executor: named(CLAUDE, []), tank })))
  })

  it.effect("a task that holds its worktree keeps it after an ok run, for the Lead's checks", () => {
    const tank = makeFakeTank({ exec: HEALTHY_EXEC })
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const held = yield* lead.intake(specFor(bot, { repo: REPO, parent: parent(), holdWorktree: true }))
      expect((yield* lead.runOnce(held.id)).kind).toBe("ok")
      expect(tank.released).toEqual([{ keepWorktree: true }])
    }).pipe(Effect.provide(leadLayer({ executor: named(CLAUDE, []), tank })))
  })

  it.effect("any other ok task still releases its worktree", () => {
    const tank = makeFakeTank({ exec: HEALTHY_EXEC })
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const plain = yield* lead.intake(specFor(bot, { repo: REPO, parent: parent() }))
      expect((yield* lead.runOnce(plain.id)).kind).toBe("ok")
      expect(tank.released).toEqual([{ keepWorktree: false }])
    }).pipe(Effect.provide(leadLayer({ executor: named(CLAUDE, []), tank })))
  })
})
