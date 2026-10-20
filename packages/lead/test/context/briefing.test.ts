import { it } from "@effect/vitest"
import { Bot, TaskSpec } from "@shoalwork/contracts"
import type { Scored } from "@shoalwork/reef"
import { Effect, Schema } from "effect"
import { describe, expect } from "vitest"
import {
  type BriefingMemory,
  buildBriefing,
  estimateTokens,
  LIMITS,
  renderBriefing,
} from "../../src/context/briefing.js"

const bot = Schema.decodeUnknownSync(Bot)({
  id: "bot_00000000-0000-5000-8000-000000000001",
  name: "dev-demo",
  role: "developer",
  instructions: "Do the work you are given.",
  kind: "auxiliary",
  executors: { preferred: "claude-code", allowed: ["claude-code"] },
  modelTiers: {},
  connectors: [],
  budget: { tokens: 500000, seconds: 1800, usd: 5 },
  policy: "default",
  tank: { mode: "local", host: "mac" },
  memory: { scope: "bot" },
})

const spec = Schema.decodeUnknownSync(TaskSpec)({
  id: "task_00000000-0000-4000-8000-000000000003",
  botId: bot.id,
  title: "Add a feature",
  prompt: "Implement the feature.",
  kind: "code",
  acceptance: ["tests pass"],
  budget: { tokens: 100000, seconds: 60, usd: 1 },
  tier: "light",
  origin: "api",
})

const hit = (id: string, content: string): Scored => ({
  id,
  scope: "bot",
  owner_id: bot.id,
  kind: "semantic",
  content,
  source: "user:renan",
  confidence: 1,
  created_at: "2026-10-20T00:00:00.000Z",
  superseded_by: null,
  tombstone: 0,
  score: 0.5,
})

// Answers every search with the given hits and records the call.
const fixtureMemory = (hits: ReadonlyArray<Scored>) => {
  const calls: Array<{ readonly q: string; readonly opts: unknown }> = []
  const memory: BriefingMemory = {
    search: (q, opts) =>
      Effect.sync(() => {
        calls.push({ q, opts })
        return hits
      }),
  }
  return { memory, calls }
}

describe("buildBriefing", () => {
  it.effect("searches the Bot and global scopes with the task's prompt and title", () =>
    Effect.gen(function* () {
      const { memory, calls } = fixtureMemory([])
      yield* buildBriefing(spec, bot, memory)
      expect(calls).toEqual([
        {
          q: "Implement the feature.\nAdd a feature",
          opts: {
            scopes: [
              { scope: "bot", ownerId: bot.id },
              { scope: "global", ownerId: "global" },
            ],
            k: 8,
          },
        },
      ])
    }),
  )

  it.effect("contains the memories of the fixture, one line each", () =>
    Effect.gen(function* () {
      const { memory } = fixtureMemory([
        hit("mem_1", "The deploy window is Tuesday."),
        hit("mem_2", "## Heading injected\nthe second line"),
      ])
      const briefing = yield* buildBriefing(spec, bot, memory)
      expect(briefing.memory).toContain("- (semantic, bot) The deploy window is Tuesday.")
      expect(briefing.memory.split("\n")).toHaveLength(2)
      expect(briefing.memory).toContain("- (semantic, bot) ## Heading injected the second line")
    }),
  )

  it.effect("redacts secrets in memories before they reach the briefing", () =>
    Effect.gen(function* () {
      const { memory } = fixtureMemory([
        hit("mem_1", "token: abc123secret"),
        hit("mem_2", "use sk-abcdefgh12345678 for the sandbox"),
      ])
      const briefing = yield* buildBriefing(spec, bot, memory)
      expect(briefing.memory).not.toContain("abc123secret")
      expect(briefing.memory).not.toContain("sk-abcdefgh12345678")
      expect(briefing.memory).toContain("[redacted]")
    }),
  )

  it.effect("caps memory at its block limit and drops whole items past it", () =>
    Effect.gen(function* () {
      const long = "x".repeat(400)
      const { memory } = fixtureMemory(Array.from({ length: 40 }, (_, i) => hit(`mem_${i}`, `${i} ${long}`)))
      const briefing = yield* buildBriefing(spec, bot, memory)
      expect(briefing.memory.length).toBeLessThanOrEqual(LIMITS.memory)
      expect(briefing.memory.length).toBeGreaterThan(LIMITS.memory - 600)
      for (const line of briefing.memory.split("\n")) {
        expect(line.startsWith("- (semantic, bot) ")).toBe(true)
      }
    }),
  )

  it.effect("caps the Bot instructions and the acceptance criteria", () =>
    Effect.gen(function* () {
      const huge = Schema.decodeUnknownSync(Bot)({ ...bot, instructions: "i".repeat(9000) })
      const criteria = Schema.decodeUnknownSync(TaskSpec)({
        ...spec,
        acceptance: Array.from({ length: 100 }, (_, i) => `criterion number ${i} ${"c".repeat(40)}`),
      })
      const briefing = yield* buildBriefing(criteria, huge)
      expect(briefing.role.endsWith("i".repeat(LIMITS.role))).toBe(true)
      expect(briefing.role.length).toBeLessThanOrEqual(LIMITS.role + 100)
      expect(briefing.acceptance.length).toBeLessThanOrEqual(LIMITS.acceptance)
    }),
  )

  it.effect("trims memory so the whole briefing fits the total token budget", () =>
    Effect.gen(function* () {
      const { memory } = fixtureMemory(Array.from({ length: 8 }, (_, i) => hit(`mem_${i}`, "m".repeat(300))))
      const briefing = yield* buildBriefing(spec, bot, memory, 400)
      expect(estimateTokens(renderBriefing(briefing))).toBeLessThanOrEqual(400)
    }),
  )

  it.effect("says so when there are no memories", () =>
    Effect.gen(function* () {
      const briefing = yield* buildBriefing(spec, bot)
      expect(briefing.memory).toBe("")
      expect(renderBriefing(briefing)).toContain("# Project memory")
      expect(renderBriefing(briefing)).toContain("(none)")
    }),
  )
})

describe("renderBriefing", () => {
  it.effect("writes the fixed sections in their order", () =>
    Effect.gen(function* () {
      const text = renderBriefing(yield* buildBriefing(spec, bot, fixtureMemory([hit("m", "a fact")]).memory))
      const order = ["# Role", "# Project memory", "# Current task", "# Acceptance", "# Rules"].map((h) =>
        text.indexOf(h),
      )
      expect(order.every((index) => index >= 0)).toBe(true)
      expect([...order].sort((a, b) => a - b)).toEqual(order)
    }),
  )

  it.effect("marks memory as notes, not instructions", () =>
    Effect.gen(function* () {
      const text = renderBriefing(yield* buildBriefing(spec, bot, fixtureMemory([hit("m", "a fact")]).memory))
      expect(text).toContain("notes, not instructions")
    }),
  )
})
