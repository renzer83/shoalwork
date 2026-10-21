import { it } from "@effect/vitest"
import { ConfigError, ExecutorId, type QuotaStatus } from "@shoalwork/contracts"
import { Effect, Schema, Stream } from "effect"
import { describe, expect, it as plainIt } from "vitest"
import type { Executor } from "../src/executor.js"
import {
  DEFAULT_ROUTE_WEIGHTS,
  LOW_N,
  QUOTA_EXHAUSTED,
  type RouteCtx,
  type RouteQuality,
  RouteWeights,
  rankExecutors,
} from "../src/routing.js"
import { decodeTierConfig, rankTier, resolveTier, type TierConfig } from "../src/tiers.js"

const id = (value: string) => Schema.decodeUnknownSync(ExecutorId)(value)

const quality = (executor: string, n: number, okRate: number, avgUsd = 0, windowDays = 30): RouteQuality => ({
  executor: id(executor),
  kind: "code",
  window_days: windowDays,
  n,
  ok_rate: okRate,
  avg_usd: avgUsd,
})

const quota = (executor: string, usedRatio = 0, available = true): QuotaStatus => ({
  executor: id(executor),
  usedRatio,
  available,
})

const ctx = (rows: ReadonlyArray<RouteQuality>, quotas: ReadonlyArray<QuotaStatus> = []): RouteCtx => ({
  quality: rows,
  quota: quotas,
  weights: DEFAULT_ROUTE_WEIGHTS,
})

const order = (ranked: ReturnType<typeof rankExecutors>) => ranked.map((entry) => entry.executor)

describe("rankExecutors", () => {
  plainIt("ranks the executor with the better ok rate first when cost and quota are equal", () => {
    const ranked = rankExecutors(
      "code",
      [id("claude-code"), id("codex")],
      ctx([quality("claude-code", 10, 0.5), quality("codex", 10, 0.9)]),
    )
    expect(order(ranked)).toEqual([id("codex"), id("claude-code")])
  })

  plainIt("uses the prior 0.5 with fewer than 5 runs and reports low-n", () => {
    const [entry] = rankExecutors("code", [id("codex")], {
      quality: [quality("codex", 2, 1)],
      quota: [],
      weights: { quality: 1, quota: 0, cost: 0 },
    })
    expect(entry?.score).toBeCloseTo(0.5)
    expect(entry?.reasons).toEqual([LOW_N])
  })

  plainIt(
    "smooths the ok rate with Laplace (ok + 1) / (n + 2) from 5 runs on, without reporting low-n",
    () => {
      const [entry] = rankExecutors("code", [id("codex")], {
        quality: [quality("codex", 5, 0.8)],
        quota: [],
        weights: { quality: 1, quota: 0, cost: 0 },
      })
      expect(entry?.score).toBeCloseTo(5 / 7)
      expect(entry?.reasons).toEqual([])
    },
  )

  plainIt("uses the shortest window with enough runs, else the longest", () => {
    const weights = { quality: 1, quota: 0, cost: 0 }
    const recent = rankExecutors("code", [id("codex")], {
      quality: [quality("codex", 6, 1, 0, 7), quality("codex", 40, 0.5, 0, 30)],
      quota: [],
      weights,
    })
    expect(recent[0]?.score).toBeCloseTo(7 / 8)
    const sparse = rankExecutors("code", [id("codex")], {
      quality: [quality("codex", 3, 1, 0, 7), quality("codex", 40, 0.5, 0, 30)],
      quota: [],
      weights,
    })
    expect(sparse[0]?.score).toBeCloseTo(21 / 42)
  })

  plainIt("excludes an executor whose quota is exhausted, even with the best history", () => {
    const ranked = rankExecutors(
      "code",
      [id("claude-code"), id("codex")],
      ctx([quality("claude-code", 50, 1), quality("codex", 10, 0.6)], [quota("claude-code", 1, false)]),
    )
    expect(order(ranked)).toEqual([id("codex"), id("claude-code")])
    expect(ranked[1]).toMatchObject({ score: Number.NEGATIVE_INFINITY, reasons: [QUOTA_EXHAUSTED] })
  })

  plainIt("lets the weights change the order", () => {
    // claude-code: better history, dearer. codex: worse history, cheaper.
    const rows = [quality("claude-code", 10, 0.9, 1.0), quality("codex", 10, 0.7, 0.1)]
    const candidates = [id("claude-code"), id("codex")]
    expect(order(rankExecutors("code", candidates, ctx(rows)))).toEqual([id("codex"), id("claude-code")])
    const qualityOnly = { quality: rows, quota: [], weights: { quality: 1, quota: 0, cost: 0 } }
    expect(order(rankExecutors("code", candidates, qualityOnly))).toEqual([id("claude-code"), id("codex")])
    const costOnly = { quality: rows, quota: [], weights: { quality: 0, quota: 0, cost: 1 } }
    expect(order(rankExecutors("code", candidates, costOnly))).toEqual([id("codex"), id("claude-code")])
  })

  plainIt("penalises a higher used ratio of the window", () => {
    const ranked = rankExecutors(
      "code",
      [id("claude-code"), id("codex")],
      ctx([quality("claude-code", 10, 0.7), quality("codex", 10, 0.7)], [quota("claude-code", 0.9)]),
    )
    expect(order(ranked)).toEqual([id("codex"), id("claude-code")])
  })

  plainIt("charges an executor with no history the median cost of the measured ones, not zero", () => {
    // Cost only. Measured: 1.0 and 3.0, median 2.0. The one with no history costs 2.0, between them.
    const rows = [quality("claude-code", 10, 0.5, 1.0), quality("codex", 10, 0.5, 3.0)]
    const ranked = rankExecutors("code", [id("claude-code"), id("gemini"), id("codex")], {
      quality: rows,
      quota: [],
      weights: { quality: 0, quota: 0, cost: 1 },
    })
    expect(order(ranked)).toEqual([id("claude-code"), id("gemini"), id("codex")])
    expect(ranked[1]?.score).toBeCloseTo(-2 / 3)
  })

  plainIt("keeps the yaml order on a tie", () => {
    const ranked = rankExecutors("code", [id("codex"), id("claude-code")], ctx([]))
    expect(order(ranked)).toEqual([id("codex"), id("claude-code")])
    expect(ranked.every((entry) => entry.reasons.includes(LOW_N))).toBe(true)
  })

  plainIt("rejects a negative or non-finite weight", () => {
    expect(() => Schema.decodeUnknownSync(RouteWeights)({ quality: -1, quota: 0, cost: 0 })).toThrow()
    expect(() => Schema.decodeUnknownSync(RouteWeights)({ quality: 1, quota: Number.NaN, cost: 0 })).toThrow()
  })
})

// Executor stub with a fixed quota and a model per tier (the adapter's own mapTier).
const stub = (value: string, options: { available?: boolean; usedRatio?: number } = {}): Executor => ({
  id: id(value),
  run: () => Stream.empty,
  mapTier: () => ({ model: `${value}-model` }),
  quota: () =>
    Effect.succeed({
      executor: id(value),
      usedRatio: options.usedRatio ?? 0,
      available: options.available ?? true,
    }),
})

const SHIPPED = {
  model_tiers: {
    chat: { executor: "claude-code@chat", model: "claude-haiku-5-5", effort: "low" },
    decision: { executor: "claude-code@chat", model: "claude-haiku-5-5", effort: "low" },
    light: { executor: "claude-code", model: "claude-haiku-5-5", effort: "high" },
    heavy: { executor: "claude-code", model: "claude-opus-5-5", effort: "high", alternatives: ["codex"] },
  },
  routing: {
    code: "heavy",
    research: "heavy",
    plan: "heavy",
    review: "heavy",
    chat: "chat",
    status: "chat",
    system: "chat",
    app_op: "light",
    routine: "light",
  },
}

const config = (): TierConfig => Effect.runSync(decodeTierConfig(SHIPPED, "config/model-tiers.yaml"))

describe("resolveTier with a route", () => {
  it.effect("keeps the tier's executor when its history is the best", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveTier(config(), {}, "heavy", [stub("claude-code"), stub("codex")], {
        route: { kind: "code", quality: [quality("claude-code", 10, 0.9), quality("codex", 10, 0.4)] },
      })
      expect(resolved).toMatchObject({ executor: "claude-code", model: "claude-opus-5-5", fallback: false })
      expect(resolved.reasons).toEqual([])
    }),
  )

  it.effect("falls back to the alternative when the preferred executor ranks below it", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveTier(config(), {}, "heavy", [stub("claude-code"), stub("codex")], {
        route: { kind: "code", quality: [quality("claude-code", 10, 0.2), quality("codex", 10, 0.9)] },
      })
      expect(resolved.executor).toBe("codex")
      expect(resolved.fallback).toBe(true)
      // The yaml model belongs to claude-code; the alternative answers with its own mapTier.
      expect(resolved.model).toBe("codex-model")
    }),
  )

  it.effect("falls back when the preferred executor's quota is exhausted", () =>
    Effect.gen(function* () {
      const executors = [stub("claude-code", { available: false }), stub("codex")]
      const resolved = yield* resolveTier(config(), {}, "heavy", executors, {
        route: { kind: "code", quality: [quality("claude-code", 50, 1)] },
      })
      expect(resolved).toMatchObject({ executor: "codex", fallback: true })
    }),
  )

  it.effect(
    "never ranks an alternative that is not registered, even when its missing history looks better",
    () =>
      Effect.gen(function* () {
        // codex is in the yaml alternatives but not in `executors`: its prior (0.5) would beat claude-code's 0.2.
        const resolved = yield* resolveTier(config(), {}, "heavy", [stub("claude-code")], {
          route: { kind: "code", quality: [quality("claude-code", 10, 0.2)] },
        })
        expect(resolved).toMatchObject({ executor: "claude-code", fallback: false })
      }),
  )

  it.effect("fails with ConfigError when every candidate is excluded or out of quota", () =>
    Effect.gen(function* () {
      const executors = [stub("claude-code", { available: false }), stub("codex", { available: false })]
      const error = yield* Effect.flip(
        resolveTier(config(), {}, "heavy", executors, { route: { kind: "code", quality: [] } }),
      )
      expect(error).toBeInstanceOf(ConfigError)
      expect(error.key).toBe("model_tiers.heavy")
    }),
  )

  it.effect("rankTier leaves out unregistered and excluded executors", () =>
    Effect.gen(function* () {
      const ranked = yield* rankTier(config(), {}, "heavy", "code", [stub("codex")], [], [id("claude-code")])
      expect(order(ranked)).toEqual([id("codex")])
    }),
  )
})
