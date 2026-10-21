import { it } from "@effect/vitest"
import { Beacon, BeaconLive } from "@shoalwork/beacon"
import { type EventType, streamIds, TaskId } from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect, Layer, Schema, Stream } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { Ranker, RankerLive } from "../../src/rank/ranker.js"
import { DEFAULT_WEIGHTS, SIGNALS } from "../../src/rank/signals.js"
import { collectTuneSamples, runRankTune } from "../../src/rank/tune-job.js"

const BOT = "bot_00000000-0000-5000-8000-000000000001"
const env = Layer.provideMerge(RankerLive(), Layer.provideMerge(BeaconLive, withTempDb()))

const taskId = (n: number) =>
  Schema.decodeUnknownSync(TaskId)(`task_00000000-0000-4000-8000-${String(n).padStart(12, "0")}`)

const verdict = (kind: string) => ({
  kind,
  summary: "s",
  evidence: [],
  cost: { tokensIn: 1, tokensOut: 1, usd: 0, seconds: 1 },
})

// Text-match chunks were used by the tasks that failed, import-linked chunks by the ones that went ok.
const ranked = (ok: boolean, n: number) => [
  { id: `t${n}-text`, used: !ok, signals: [1, 0.9, 0, 0, 0, 0] as const },
  { id: `t${n}-link`, used: ok, signals: [0.3, 0, 0, 1, 0, 0.6] as const },
  { id: `t${n}-noise`, used: false, signals: [0, 0, 0.2, 0, 0, 0] as const },
]

const record = (n: number, kind: string, withRanked = true) =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    const id = taskId(n)
    const base = { actor: "test", correlationId: id, streamId: streamIds.task(id) }
    const type = (t: EventType, payload: unknown) => beacon.append({ ...base, type: t, payload })
    yield* type("context.assembled", {
      taskId: id,
      level: "top3",
      used: 10,
      budget: 100,
      dropped: [],
      ...(withRanked ? { ranked: ranked(kind === "ok", n) } : {}),
    })
    yield* type("executor.finished", { taskId: id, botId: BOT, verdict: verdict(kind), durationMs: 5 })
  })

describe("collectTuneSamples", () => {
  it.effect("pairs each ranked briefing with the verdict that followed it, newest first", () =>
    Effect.gen(function* () {
      yield* record(1, "ok")
      yield* record(2, "failed")
      yield* record(3, "blocked")
      yield* record(4, "ok", false)
      const samples = yield* collectTuneSamples()
      expect(samples.map((sample) => sample.ok)).toEqual([false, true])
      expect(samples[1]?.candidates[0]).toMatchObject({ id: "t1-text", used: false })
      expect(samples[1]?.candidates[1]?.signals).toMatchObject({ imports: 1, proximity: 0.6 })
      expect((yield* collectTuneSamples(1)).length).toBe(1)
    }).pipe(Effect.provide(env)),
  )

  it.effect("leaves out a briefing whose run has not finished", () =>
    Effect.gen(function* () {
      const beacon = yield* Beacon
      const id = taskId(9)
      yield* beacon.append({
        streamId: streamIds.task(id),
        type: "context.assembled",
        payload: { taskId: id, level: "top3", used: 1, budget: 2, dropped: [], ranked: ranked(true, 9) },
        actor: "test",
        correlationId: id,
      })
      expect(yield* collectTuneSamples()).toEqual([])
    }).pipe(Effect.provide(env)),
  )
})

describe("runRankTune", () => {
  it.effect("tunes on the recorded briefings, stores the weights and records context.weights_updated", () =>
    Effect.gen(function* () {
      for (let n = 1; n <= 12; n++) yield* record(n, n % 2 === 0 ? "ok" : "failed")
      const report = yield* runRankTune(DEFAULT_WEIGHTS)
      expect(report.changed).toBe(true)
      expect(report.samples).toBe(12)
      expect(yield* (yield* Ranker).weights()).toEqual(report.weights)

      const beacon = yield* Beacon
      const events = Array.from(yield* Stream.runCollect(beacon.readStream(streamIds.system, 0)))
      const updated = events.filter((event) => event.type === "context.weights_updated")
      expect(updated).toHaveLength(1)
      expect(updated[0]?.payload).toMatchObject({
        samples: 12,
        before: DEFAULT_WEIGHTS,
        after: report.weights,
      })
      const sum = SIGNALS.reduce((total, signal) => total + report.weights[signal], 0)
      expect(sum).toBeCloseTo(1)
    }).pipe(Effect.provide(env)),
  )

  it.effect("changes nothing and records nothing without enough briefings", () =>
    Effect.gen(function* () {
      yield* record(1, "ok")
      const report = yield* runRankTune(DEFAULT_WEIGHTS)
      expect(report.changed).toBe(false)
      const sql = yield* SqlClient
      expect(yield* sql`SELECT * FROM rank_weights`).toEqual([])
      const beacon = yield* Beacon
      const events = Array.from(yield* Stream.runCollect(beacon.readStream(streamIds.system, 0)))
      expect(events.filter((event) => event.type === "context.weights_updated")).toEqual([])
    }).pipe(Effect.provide(env)),
  )
})
