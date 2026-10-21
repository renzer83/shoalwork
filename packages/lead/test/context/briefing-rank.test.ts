import { it } from "@effect/vitest"
import { ExecutorId, type ExecutorTask } from "@shoalwork/contracts"
import { DEFAULT_WEIGHTS, type RankedCode } from "@shoalwork/reef"
import type { TankContext } from "@shoalwork/tank"
import { Effect, Schema } from "effect"
import { describe, expect } from "vitest"
import type { BriefingRankedCode } from "../../src/context/briefing.js"
import { decodeContextConfigText } from "../../src/context/config.js"
import { type ContextAssembled, makeInjector } from "../../src/context/inject.js"
import { makeFakeTank } from "../support.js"
import { build, chunk, deps, fixtureCode, repo, withSpec } from "./briefing-support.js"
import { bot, spec } from "./fixtures.js"

const SIGNALS = { bm25: 1, cosine: 0.5, recency: 0.123456, imports: 0, success: 0.25, proximity: 0.6 }

const rankedOf = (ids: ReadonlyArray<string>, k: number): RankedCode => ({
  hits: ids.slice(0, k).map((id, index) => chunk(id, `content of ${id}`, 1 - index / 10)),
  considered: ids.map((id, index) => ({ id, used: index < k, signals: SIGNALS })),
})

const fixtureRanked = (ids: ReadonlyArray<string>) => {
  const calls: Array<{
    readonly repo: string
    readonly query: string
    readonly files: ReadonlyArray<string>
    readonly k: number
  }> = []
  const rankedCode: BriefingRankedCode = (r, query, files, k) =>
    Effect.sync(() => {
      calls.push({ repo: r.url, query, files, k })
      return rankedOf(ids, k)
    })
  return { rankedCode, calls }
}

const codeTask = (prompt: string) => withSpec({ kind: "code", repo, tier: "heavy", prompt })

describe("buildBriefing with ranked code", () => {
  it.effect("serves the code block from the ranked search with the files the prompt names", () =>
    Effect.gen(function* () {
      const { rankedCode, calls } = fixtureRanked(["src/a.ts", "src/b.ts", "src/c.ts"])
      const plain = fixtureCode([chunk("plain.ts", "plain")])
      const briefing = yield* build(codeTask("Fix src/a.ts and ./lib/b.py now"), {
        rankedCode,
        code: plain.code,
      })
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ repo: repo.url, files: ["src/a.ts", "lib/b.py"], k: 6 })
      expect(plain.calls).toEqual([])
      expect(briefing.text).toContain("content of src/a.ts")
      expect(briefing.text).not.toContain("plain.ts")
      expect(briefing.ranked?.map((entry) => entry.id)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"])
    }),
  )

  it.effect("adds the files given by the caller (the previous attempt's edits) to the prompt's", () =>
    Effect.gen(function* () {
      const { rankedCode, calls } = fixtureRanked(["a.ts"])
      yield* buildBriefingWith(rankedCode, ["src/edited.ts", "src/a.ts"])
      expect(calls[0]?.files).toEqual(["src/a.ts", "src/edited.ts"])
    }),
  )

  it.effect("falls back to the plain search when the ranking fails, and reports it", () =>
    Effect.gen(function* () {
      const reported: Array<string> = []
      const plain = fixtureCode([chunk("plain.ts", "plain content")])
      const briefing = yield* build(codeTask("Do it"), {
        rankedCode: () => Effect.fail("ranker down"),
        code: plain.code,
        onSourceError: (source) =>
          Effect.sync(() => {
            reported.push(source)
          }),
      })
      expect(reported).toEqual(["code"])
      expect(plain.calls).toHaveLength(1)
      expect(briefing.text).toContain("plain content")
      expect(briefing.ranked).toBeUndefined()
    }),
  )

  it.effect("does not rank at level none or without a repo", () =>
    Effect.gen(function* () {
      const { rankedCode, calls } = fixtureRanked(["a.ts"])
      yield* build(withSpec({ kind: "chat", tier: "chat", repo }), { rankedCode })
      yield* build(withSpec({ kind: "code", tier: "heavy" }), { rankedCode })
      expect(calls).toEqual([])
    }),
  )

  it.effect("without a ranked search the briefing is built as before", () =>
    Effect.gen(function* () {
      const plain = fixtureCode([chunk("plain.ts", "plain content")])
      const briefing = yield* build(codeTask("Do it"), { code: plain.code })
      expect(briefing.text).toContain("plain content")
      expect(briefing.ranked).toBeUndefined()
    }),
  )
})

const buildBriefingWith = (rankedCode: BriefingRankedCode, activeFiles: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const { buildBriefing } = yield* Effect.promise(() => import("../../src/context/briefing.js"))
    const { config, planner, scratch } = yield* Effect.promise(() => import("./briefing-support.js"))
    const task = codeTask("Look at src/a.ts")
    return yield* buildBriefing(deps({ rankedCode }), {
      spec: task,
      bot,
      ctx: scratch,
      plan: planner.plan(task, { complexity: 3 }),
      config,
      activeFiles,
    })
  })

const scratchCtx: TankContext = { botId: bot.id, botName: bot.name, cwd: "/work", home: "/home", env: {} }
const executorTask: ExecutorTask = {
  taskId: spec.id,
  botId: bot.id,
  prompt: "Implement the feature.",
  tier: "light",
  allowedTools: [],
  permissionMode: "edit",
  maxTurns: 50,
  budget: spec.budget,
}

describe("makeInjector with ranked code", () => {
  it.effect("records the considered candidates in context.assembled with rounded signals", () => {
    const recorded: Array<ContextAssembled> = []
    const { rankedCode } = fixtureRanked(["x.ts", "y.ts"])
    const inject = makeInjector({
      tank: makeFakeTank().shape,
      memory: undefined,
      rankedCode,
      raiseError: () => Effect.void,
      recordAssembled: (_spec, payload) =>
        Effect.sync(() => {
          recorded.push(payload)
        }),
    })
    const withRepo = withSpec({ kind: "code", repo, tier: "heavy" })
    return Effect.gen(function* () {
      yield* Effect.scoped(
        inject(scratchCtx, {
          spec: withRepo,
          bot,
          task: executorTask,
          executor: Schema.decodeUnknownSync(ExecutorId)("claude-code"),
        }),
      )
      expect(recorded[0]?.ranked).toEqual([
        { id: "x.ts", used: true, signals: [1, 0.5, 0.123, 0, 0.25, 0.6] },
        { id: "y.ts", used: true, signals: [1, 0.5, 0.123, 0, 0.25, 0.6] },
      ])
    })
  })
})

describe("rank config", () => {
  const base = [
    "budget: { chat: 2000, decision: 2000, light: 8000, heavy: 24000 }",
    "reserve_for_answer: 300",
    "blocks: { instructions: 700, rules: 600, memory: 1500, code: 4000, git: 800, docs: 1200, working: 500, acceptance: 250, task: 150 }",
    "levels: { top3: { memory: 3, code: 3 }, full: { memory: 8, code: 6 } }",
  ]

  it.effect("reads rank.weights", () =>
    Effect.gen(function* () {
      const text = [
        ...base,
        "rank: { weights: { bm25: 1, cosine: 0, recency: 0, imports: 0, success: 0, proximity: 0 } }",
      ].join("\n")
      const config = yield* decodeContextConfigText(text, "ctx.yaml")
      expect(config.rank?.weights.bm25).toBe(1)
    }),
  )

  it.effect("a file without rank gets the default weights", () =>
    Effect.gen(function* () {
      expect((yield* decodeContextConfigText(base.join("\n"), "ctx.yaml")).rank).toEqual({
        weights: DEFAULT_WEIGHTS,
      })
    }),
  )

  it.effect("weights that do not add up to 1 are a ConfigError naming the file", () =>
    Effect.gen(function* () {
      const text = [
        ...base,
        "rank: { weights: { bm25: 0.5, cosine: 0.25, recency: 0.1, imports: 0.15, success: 0.15, proximity: 0.1 } }",
      ].join("\n")
      const error = yield* Effect.flip(decodeContextConfigText(text, "ctx.yaml"))
      expect(error._tag).toBe("ConfigError")
      expect(error.key).toBe("ctx.yaml")
    }),
  )
})

describe("ranked chunks the budget cut", () => {
  it.effect("are not marked as used in the considered candidates", () =>
    Effect.gen(function* () {
      const big = "x".repeat(2900)
      const ids = ["k1", "k2", "k3", "k4", "k5", "k6"]
      const rankedCode: BriefingRankedCode = (_repo, _query, _files, k) =>
        Effect.succeed({
          hits: ids.slice(0, k).map((id, i) => chunk(id, `${big}\n#${id}#`, 1 - i / 10)),
          considered: ids.map((id, i) => ({ id, used: i < k, signals: SIGNALS })),
        })
      const briefing = yield* build(withSpec({ kind: "code", repo, tier: "heavy", prompt: "Do it" }), {
        rankedCode,
      })
      const usedIds = (briefing.ranked ?? []).filter((entry) => entry.used).map((entry) => entry.id)
      const inText = ids.filter((id) => briefing.text.includes(`#${id}#`))
      // The block cap (4000 tokens) holds fewer than the 6 asked: the lowest-ranked ones were dropped.
      expect(briefing.dropped.some((entry) => entry.block === "code")).toBe(true)
      expect(usedIds.length).toBeLessThan(6)
      expect(usedIds.length).toBeGreaterThan(0)
      expect(new Set(usedIds)).toEqual(new Set(inText))
      expect(briefing.ranked?.map((entry) => entry.id)).toEqual(ids)
    }),
  )
})
