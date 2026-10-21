import { type Event, EventPayloads, ExecutorId, type TaskId, TaskKind } from "@shoalwork/contracts"
import { DateTime, Effect, Option, Schema } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"

const DAY_MS = 86_400_000

// The window a row is computed for: the `days` before `now` (epoch ms). Injected, so the projection is pure.
export interface QualityWindow {
  readonly days: number
  readonly now: number
}

const Rate = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))

// One row of executor_quality (migration 0024). Field names are the column names.
export const ExecutorQualityRow = Schema.Struct({
  executor: ExecutorId,
  kind: TaskKind,
  window_days: Schema.Int,
  n: Schema.Int,
  ok_rate: Rate,
  retry_rate: Rate,
  avg_usd: Schema.Number,
  avg_seconds: Schema.Number,
  computed_at: Schema.String,
})
export type ExecutorQualityRow = typeof ExecutorQualityRow.Type

const decodeTaskReceived = Schema.decodeUnknownOption(EventPayloads["task.received"])
const decodeStarted = Schema.decodeUnknownOption(EventPayloads["executor.started"])
const decodeFinished = Schema.decodeUnknownOption(EventPayloads["executor.finished"])
const decodeUsage = Schema.decodeUnknownOption(EventPayloads["usage.recorded"])

// A counted run: one executor.finished with its executor, its verdict, its retry flag and the usd spent in it.
interface Run {
  readonly taskId: TaskId
  readonly executor: ExecutorId
  readonly ok: boolean
  readonly retry: boolean
  readonly durationMs: number
  readonly usd: number
  readonly at: number
}

interface Collected {
  readonly kindOf: ReadonlyMap<TaskId, TaskKind>
  readonly runs: ReadonlyArray<Run>
}

interface Group {
  readonly executor: ExecutorId
  readonly kind: TaskKind
  n: number
  ok: number
  retries: number
  durationMs: number
  usd: number
}

// A run is one executor.finished. Its executor is the one of the executor.started with the same task and step. Its usd
// is the usage.recorded of that same run (between its started and its finished). A run is a retry when an earlier
// finished run of the same task and step exists: a later step of a plan is not a retry of the first one.
const runKey = (taskId: TaskId, stepId: string | undefined): string => `${taskId}|${stepId ?? ""}`

// One decode pass over the events, in log order. Runs whose executor.started is missing are dropped.
const collect = (events: ReadonlyArray<Event>): Collected => {
  const ordered = [...events].sort((a, b) => a.position - b.position)
  const kindOf = new Map<TaskId, TaskKind>()
  const executorOf = new Map<string, ExecutorId>()
  const finishedSoFar = new Map<string, number>()
  const spendOpen = new Map<string, number>()
  const runs: Array<Run> = []

  for (const event of ordered) {
    if (event.type === "task.received") {
      const payload = Option.getOrUndefined(decodeTaskReceived(event.payload))
      if (payload !== undefined) kindOf.set(payload.task.id, payload.task.kind)
    } else if (event.type === "executor.started") {
      const payload = Option.getOrUndefined(decodeStarted(event.payload))
      if (payload === undefined) continue
      const key = runKey(payload.taskId, payload.stepId)
      executorOf.set(key, payload.executor)
      spendOpen.set(key, 0)
    } else if (event.type === "usage.recorded") {
      const payload = Option.getOrUndefined(decodeUsage(event.payload))
      if (payload === undefined) continue
      const key = runKey(payload.taskId, payload.stepId)
      spendOpen.set(key, (spendOpen.get(key) ?? 0) + payload.usage.usd)
    } else if (event.type === "executor.finished") {
      const payload = Option.getOrUndefined(decodeFinished(event.payload))
      if (payload === undefined) continue
      const key = runKey(payload.taskId, payload.stepId)
      const prior = finishedSoFar.get(key) ?? 0
      finishedSoFar.set(key, prior + 1)
      const usd = spendOpen.get(key) ?? 0
      spendOpen.delete(key)
      const executor = executorOf.get(key)
      if (executor === undefined) continue
      runs.push({
        taskId: payload.taskId,
        executor,
        ok: payload.verdict.kind === "ok",
        retry: prior > 0,
        durationMs: payload.durationMs,
        usd,
        at: DateTime.toEpochMillis(event.occurredAt),
      })
    }
  }
  return { kindOf, runs }
}

// Rows of one window from the collected runs: only runs inside (now - days, now] count.
const rowsOf = (collected: Collected, now: number, days: number): ReadonlyArray<ExecutorQualityRow> => {
  const from = now - days * DAY_MS
  const groups = new Map<string, Group>()
  for (const run of collected.runs) {
    if (run.at <= from || run.at > now) continue
    const kind = collected.kindOf.get(run.taskId)
    if (kind === undefined) continue
    const key = JSON.stringify([run.executor, kind])
    const group = groups.get(key) ?? {
      executor: run.executor,
      kind,
      n: 0,
      ok: 0,
      retries: 0,
      durationMs: 0,
      usd: 0,
    }
    groups.set(key, group)
    group.n += 1
    if (run.ok) group.ok += 1
    if (run.retry) group.retries += 1
    group.durationMs += run.durationMs
    group.usd += run.usd
  }
  const computedAt = new Date(now).toISOString()
  return [...groups.values()]
    .sort((a, b) => a.executor.localeCompare(b.executor) || a.kind.localeCompare(b.kind))
    .map((group) => ({
      executor: group.executor,
      kind: group.kind,
      window_days: days,
      n: group.n,
      ok_rate: group.ok / group.n,
      retry_rate: group.retries / group.n,
      avg_usd: group.usd / group.n,
      avg_seconds: group.durationMs / 1000 / group.n,
      computed_at: computedAt,
    }))
}

// One window's rows. ok_rate and retry_rate are per run; avg_usd and avg_seconds are per run too.
export const computeExecutorQuality = (
  events: ReadonlyArray<Event>,
  window: QualityWindow,
): ReadonlyArray<ExecutorQualityRow> => rowsOf(collect(events), window.now, window.days)

// Every window at once from a single decode of the events (the core job asks for 7 and 30 days together).
export const computeExecutorQualityWindows = (
  events: ReadonlyArray<Event>,
  now: number,
  days: ReadonlyArray<number>,
): ReadonlyArray<ExecutorQualityRow> => {
  const collected = collect(events)
  return days.flatMap((window) => rowsOf(collected, now, window))
}

// Every row of executor_quality, decoded at the boundary. The core writes the table (services/core/src/jobs).
export const readExecutorQualityRows = (
  sql: SqlClient,
): Effect.Effect<ReadonlyArray<ExecutorQualityRow>, SqlError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const rows =
      yield* sql`SELECT executor, kind, window_days, n, ok_rate, retry_rate, avg_usd, avg_seconds, computed_at
      FROM executor_quality`
    return yield* Schema.decodeUnknownEffect(Schema.Array(ExecutorQualityRow))(rows)
  })
