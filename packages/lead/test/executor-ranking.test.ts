import { it } from "@effect/vitest"
import { Beacon, BeaconLive, type ExecutorQualityRow } from "@shoalwork/beacon"
import { ExecutorId, streamIds, TaskId } from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { type Executor, type ExecutorRegistry, TierConfig } from "@shoalwork/executors"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { chooseExecutor, rankForBot } from "../src/choose.js"

const id = (value: string) => Schema.decodeUnknownSync(ExecutorId)(value)
const CLAUDE = id("claude-code")
const CODEX = id("codex")

// Same routing as config/model-tiers.yaml for heavy: claude-code, with codex as the alternative.
const TIERS = Schema.decodeUnknownSync(TierConfig)({
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
})

const fake = (value: ExecutorId): Executor => ({
  id: value,
  run: () => Stream.empty,
  mapTier: () => ({ model: `${value}-model` }),
  quota: () => Effect.succeed({ executor: value, usedRatio: 0, available: true }),
})

const registry: typeof ExecutorRegistry.Service = {
  list: () => [CLAUDE, CODEX],
  get: (value) => Effect.succeed(fake(value)),
}

const quality = (executor: ExecutorId, n: number, okRate: number): ExecutorQualityRow => ({
  executor,
  kind: "code",
  window_days: 30,
  n,
  ok_rate: okRate,
  retry_rate: 0,
  avg_usd: 0,
  avg_seconds: 1,
  computed_at: "2026-10-21T10:00:00.000Z",
})

const bot = (allowed: ReadonlyArray<ExecutorId>) => ({
  executors: { preferred: CLAUDE, allowed },
  modelTiers: {},
})

describe("rankForBot", () => {
  it.effect("never ranks an executor the Bot may not use, even with the best history", () =>
    Effect.gen(function* () {
      const ranked = yield* rankForBot(TIERS, bot([CLAUDE]), "heavy", "code", registry, [
        quality(CODEX, 50, 1),
        quality(CLAUDE, 10, 0.3),
      ])
      expect(ranked.map((entry) => entry.executor)).toEqual([CLAUDE])
      expect(ranked.some((entry) => entry.executor === CODEX)).toBe(false)
    }),
  )

  it.effect("ranks both when the Bot may use both, the better history first", () =>
    Effect.gen(function* () {
      const ranked = yield* rankForBot(TIERS, bot([CLAUDE, CODEX]), "heavy", "code", registry, [
        quality(CODEX, 10, 0.9),
        quality(CLAUDE, 10, 0.2),
      ])
      expect(ranked.map((entry) => entry.executor)).toEqual([CODEX, CLAUDE])
    }),
  )
})

const withBeacon = () => Layer.provideMerge(BeaconLive, withTempDb())

describe("chooseExecutor with a route", () => {
  it.effect("takes the alternative with the better history and records the choice as decision.made", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const beacon = yield* Beacon
      const taskId = Schema.decodeUnknownSync(TaskId)("task_00000000-0000-4000-8000-000000000001")
      yield* sql`INSERT INTO executor_quality (executor, kind, window_days, n, ok_rate, retry_rate, avg_usd, avg_seconds, computed_at)
        VALUES ('claude-code', 'code', 30, 10, 0.1, 0, 0, 1, '2026-10-21T10:00:00.000Z'),
          ('codex', 'code', 30, 10, 1, 0, 0, 1, '2026-10-21T10:00:00.000Z')`

      const chosen = yield* chooseExecutor(TIERS, bot([CLAUDE, CODEX]), "heavy", registry, [], {
        kind: "code",
        correlationId: taskId,
      })

      expect(Option.getOrUndefined(chosen)?.executor.id).toBe(CODEX)
      expect(Option.getOrUndefined(chosen)?.reasons).toEqual([])
      const decisions = yield* Stream.runCollect(beacon.readAll(0, ["decision.made"]))
      const executorChoices = decisions.filter(
        (event) => (event.payload as { readonly questionId?: string }).questionId === "executor",
      )
      expect(executorChoices).toHaveLength(1)
      expect(executorChoices[0]?.streamId).toBe(streamIds.system)
      expect(executorChoices[0]?.payload).toMatchObject({
        value: CODEX,
        source: "rule",
        facts: { kind: "code" },
      })
    }).pipe(Effect.provide(withBeacon())),
  )

  it.effect("without a route the table decides and nothing is recorded", () =>
    Effect.gen(function* () {
      const beacon = yield* Beacon
      const chosen = yield* chooseExecutor(TIERS, bot([CLAUDE, CODEX]), "heavy", registry)
      expect(Option.getOrUndefined(chosen)?.executor.id).toBe(CLAUDE)
      expect(Option.getOrUndefined(chosen)?.reasons).toBeUndefined()
      expect(yield* Stream.runCollect(beacon.readAll(0, ["decision.made"]))).toHaveLength(0)
    }).pipe(Effect.provide(withBeacon())),
  )
})
