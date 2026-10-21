import { it } from "@effect/vitest"
import { BotId, type Event, type NewEvent, StepId, streamIds, TaskId } from "@shoalwork/contracts"
import { DateTime, Effect, Schema, Stream } from "effect"
import { describe, expect } from "vitest"
import { Beacon, BeaconTest } from "../src/index.js"
import {
  computeExecutorQuality,
  computeExecutorQualityWindows,
  ExecutorQualityRow,
} from "../src/projections/executor-quality.js"

const DAY_MS = 86_400_000
const sequence = (n: number, prefix: string) =>
  `${prefix}_00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const taskId = (n: number) => Schema.decodeUnknownSync(TaskId)(sequence(n, "task"))
const BOT = Schema.decodeUnknownSync(BotId)(sequence(1, "bot"))
const STEP_A = Schema.decodeUnknownSync(StepId)(sequence(1, "step"))
const STEP_B = Schema.decodeUnknownSync(StepId)(sequence(2, "step"))

const T1 = taskId(1)
const T2 = taskId(2)
const T3 = taskId(3)
const T4 = taskId(4)
const T5 = taskId(5)
const T6 = taskId(6)
const T7 = taskId(7)
const T8 = taskId(8)

const CORR = "corr_executor_quality"
const verdict = (kind: "ok" | "failed") => ({
  kind,
  summary: "s",
  evidence: [],
  cost: { tokensIn: 0, tokensOut: 0, usd: 0, seconds: 0 },
})

const received = (id: typeof T1, kind: string): NewEvent => ({
  streamId: streamIds.task(id),
  type: "task.received",
  payload: {
    task: {
      id,
      botId: BOT,
      title: "t",
      prompt: "p",
      kind,
      acceptance: [],
      budget: { tokens: 1, seconds: 1, usd: 1 },
      tier: "heavy",
      origin: "cli",
    },
  },
  actor: "system:test",
  correlationId: CORR,
})

const started = (id: typeof T1, executor: string, stepId?: typeof STEP_A): NewEvent => ({
  streamId: streamIds.task(id),
  type: "executor.started",
  payload: {
    taskId: id,
    ...(stepId === undefined ? {} : { stepId }),
    botId: BOT,
    executor,
    model: "m",
    cwd: "/tmp",
  },
  actor: "system:test",
  correlationId: CORR,
})

const finished = (
  id: typeof T1,
  kind: "ok" | "failed",
  durationMs: number,
  stepId?: typeof STEP_A,
): NewEvent => ({
  streamId: streamIds.task(id),
  type: "executor.finished",
  payload: {
    taskId: id,
    ...(stepId === undefined ? {} : { stepId }),
    botId: BOT,
    verdict: verdict(kind),
    durationMs,
  },
  actor: "system:test",
  correlationId: CORR,
})

const spent = (id: typeof T1, executor: string, usd: number, stepId?: typeof STEP_A): NewEvent => ({
  streamId: streamIds.task(id),
  type: "usage.recorded",
  payload: {
    taskId: id,
    ...(stepId === undefined ? {} : { stepId }),
    botId: BOT,
    executor,
    model: "m",
    usage: { tokensIn: 1, tokensOut: 1, cacheRead: 0, cacheWrite: 0, usd, seconds: 1 },
  },
  actor: "system:test",
  correlationId: CORR,
})

// One run of a task's step: started, usage 0.5 while open, finished. Ids and verdict are the caller's.
const stepRun = (id: typeof T1, stepId: typeof STEP_A, kind: "ok" | "failed"): ReadonlyArray<NewEvent> => [
  started(id, "claude-code", stepId),
  spent(id, "claude-code", 0.5, stepId),
  finished(id, kind, 1_000, stepId),
]

// Two executors, three kinds. claude-code/code: T1 ok, T1 retry failed, T2 ok. codex/code: T6 failed.
// claude-code/research: T3 ok. app_op has only spend (T4). T5 finishes with no started and no task.received.
const FIXTURE: ReadonlyArray<NewEvent> = [
  received(T1, "code"),
  received(T2, "code"),
  received(T3, "research"),
  received(T4, "app_op"),
  received(T6, "code"),
  started(T1, "claude-code"),
  spent(T1, "claude-code", 0.1),
  finished(T1, "ok", 10_000),
  started(T1, "claude-code"),
  spent(T1, "claude-code", 0.3),
  finished(T1, "failed", 20_000),
  started(T2, "claude-code"),
  spent(T2, "claude-code", 0.02),
  finished(T2, "ok", 5_000),
  started(T3, "claude-code"),
  spent(T3, "claude-code", 0.05),
  finished(T3, "ok", 4_000),
  started(T6, "codex"),
  spent(T6, "codex", 0),
  finished(T6, "failed", 30_000),
  spent(T4, "codex", 0.9),
  finished(T5, "ok", 1_000),
]

// Runs the body against an in-memory log holding the given events; hands it the events and the time of the last one.
const withEvents = <A, E>(
  events: ReadonlyArray<NewEvent>,
  body: (events: ReadonlyArray<Event>, last: number) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    yield* beacon.appendMany(events)
    const logged = yield* Stream.runCollect(beacon.readAll())
    const last = Math.max(...logged.map((event) => DateTime.toEpochMillis(event.occurredAt)))
    return yield* body(logged, last)
  }).pipe(Effect.provide(BeaconTest))

const withFixture = <A, E>(body: (events: ReadonlyArray<Event>, last: number) => Effect.Effect<A, E>) =>
  withEvents(FIXTURE, body)

describe("computeExecutorQuality", () => {
  it.effect("takes ok rate, retry rate, cost and duration per executor and kind", () =>
    withFixture((events, last) =>
      Effect.sync(() => {
        const rows = computeExecutorQuality(events, { days: 7, now: last })
        expect(rows.map((row) => [row.executor, row.kind, row.n])).toEqual([
          ["claude-code", "code", 3],
          ["claude-code", "research", 1],
          ["codex", "code", 1],
        ])
        const code = rows[0]
        expect(code?.ok_rate).toBeCloseTo(2 / 3)
        expect(code?.retry_rate).toBeCloseTo(1 / 3)
        expect(code?.avg_usd).toBeCloseTo(0.42 / 3)
        expect(code?.avg_seconds).toBeCloseTo(35 / 3)
        expect(rows[1]).toMatchObject({ ok_rate: 1, retry_rate: 0, window_days: 7 })
        expect(rows[2]).toMatchObject({ ok_rate: 0, retry_rate: 0, avg_usd: 0, avg_seconds: 30 })
      }),
    ),
  )

  it.effect("leaves out runs outside the window and stamps the rows with now", () =>
    withFixture((events, last) =>
      Effect.sync(() => {
        expect(computeExecutorQuality(events, { days: 1, now: last + 2 * DAY_MS })).toEqual([])
        const later = computeExecutorQuality(events, { days: 30, now: last + 8 * DAY_MS })
        expect(later).toHaveLength(3)
        expect(later.every((row) => row.window_days === 30)).toBe(true)
        expect(later[0]?.computed_at).toBe(new Date(last + 8 * DAY_MS).toISOString())
      }),
    ),
  )

  it.effect("makes no row for a kind with spend only, nor for a run without its start or its task", () =>
    withFixture((events, last) =>
      Effect.sync(() => {
        const rows = computeExecutorQuality(events, { days: 7, now: last })
        expect(rows.some((row) => row.kind === "app_op")).toBe(false)
        expect(rows.reduce((total, row) => total + row.n, 0)).toBe(5)
      }),
    ),
  )

  it.effect("does not count a later step of a plan as a retry", () =>
    withEvents(
      [received(T7, "code"), ...stepRun(T7, STEP_A, "ok"), ...stepRun(T7, STEP_B, "ok")],
      (events, last) =>
        Effect.sync(() => {
          const [row] = computeExecutorQuality(events, { days: 7, now: last })
          expect(row).toMatchObject({ n: 2, ok_rate: 1, retry_rate: 0, avg_usd: 0.5 })
        }),
    ),
  )

  it.effect("counts a second finished run of the same step as a retry", () =>
    withEvents(
      [received(T8, "code"), ...stepRun(T8, STEP_A, "failed"), ...stepRun(T8, STEP_A, "ok")],
      (events, last) =>
        Effect.sync(() => {
          const [row] = computeExecutorQuality(events, { days: 7, now: last })
          expect(row).toMatchObject({ n: 2, ok_rate: 0.5, retry_rate: 0.5 })
        }),
    ),
  )

  it.effect("a usage recorded after its run finished is not that run's cost", () =>
    withEvents(
      [received(T8, "code"), started(T8, "codex"), finished(T8, "ok", 1_000), spent(T8, "codex", 5)],
      (events, last) =>
        Effect.sync(() => {
          const [row] = computeExecutorQuality(events, { days: 7, now: last })
          expect(row?.avg_usd).toBe(0)
        }),
    ),
  )

  it.effect("the windows of one pass equal the windows computed one by one", () =>
    withFixture((events, last) =>
      Effect.sync(() => {
        const together = computeExecutorQualityWindows(events, last, [7, 30])
        const apart = [
          ...computeExecutorQuality(events, { days: 7, now: last }),
          ...computeExecutorQuality(events, { days: 30, now: last }),
        ]
        expect(together).toEqual(apart)
      }),
    ),
  )
})

describe("ExecutorQualityRow", () => {
  const valid = {
    executor: "claude-code",
    kind: "code",
    window_days: 7,
    n: 3,
    ok_rate: 0.5,
    retry_rate: 0,
    avg_usd: 0.1,
    avg_seconds: 12,
    computed_at: "2026-10-21T10:00:00.000Z",
  }

  it("round-trips a valid row", () => {
    const decoded = Schema.decodeUnknownSync(ExecutorQualityRow)(valid)
    expect(Schema.encodeUnknownSync(ExecutorQualityRow)(decoded)).toEqual(valid)
  })

  it("rejects a rate above 1 and an unknown task kind", () => {
    expect(() => Schema.decodeUnknownSync(ExecutorQualityRow)({ ...valid, ok_rate: 1.5 })).toThrow()
    expect(() => Schema.decodeUnknownSync(ExecutorQualityRow)({ ...valid, kind: "dance" })).toThrow()
  })
})
