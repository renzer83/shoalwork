import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"

// A minimal event shape for metrics: source-agnostic, so the same function scores a bridge fixture and the
// Beacon's own events (mapped to the same { taskId, type, at }).
export interface MetricEvent {
  readonly taskId: string
  readonly type: string
  readonly at: string
}

export interface ProjectMetrics {
  readonly leadTimeMedianMs: number | null
  readonly leadTimeP90Ms: number | null
  readonly throughputPerDay: number
  readonly idleSeconds: number
  readonly retriesPerTask: number
  readonly stuckPerWeek: number
}

export interface BaselineRow {
  readonly project: string
  readonly metric: string
  readonly value: number
  readonly windowFrom: string
  readonly windowTo: string
}

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
// Gaps shorter than this are "working", not idle.
const IDLE_GRACE_MS = 60_000

// Both the bridge event names and the Beacon event names are accepted as lifecycle markers.
const OPEN = new Set(["opened", "created", "task.received", "issue_opened", "task_created"])
const CLOSE = new Set(["merged", "closed", "done", "task.done", "task_closed"])
const RETRY = new Set(["retry", "retried"])

const median = (sorted: ReadonlyArray<number>): number | null => {
  if (sorted.length === 0) return null
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid] ?? null
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

const percentile = (sorted: ReadonlyArray<number>, p: number): number | null => {
  if (sorted.length === 0) return null
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))
  return sorted[index] ?? null
}

// Pure: derived only from the events. lead time is close - open per task (tasks without both are skipped);
// idle is the sum of inter-event gaps above 60 s over the number of transitions, in seconds; stuck counts tasks
// opened but not closed whose last event is over an hour behind the newest event.
export const computeMetrics = (events: ReadonlyArray<MetricEvent>): ProjectMetrics => {
  if (events.length === 0) {
    return {
      leadTimeMedianMs: null,
      leadTimeP90Ms: null,
      throughputPerDay: 0,
      idleSeconds: 0,
      retriesPerTask: 0,
      stuckPerWeek: 0,
    }
  }
  const times = events.map((event) => Date.parse(event.at))
  const minAt = Math.min(...times)
  const maxAt = Math.max(...times)
  const days = Math.max(1, (maxAt - minAt) / DAY_MS)

  const byTask = new Map<string, Array<MetricEvent>>()
  for (const event of events) {
    const list = byTask.get(event.taskId) ?? []
    list.push(event)
    byTask.set(event.taskId, list)
  }

  const leadTimes: Array<number> = []
  let retries = 0
  let stuck = 0
  for (const taskEvents of byTask.values()) {
    let openAt: number | undefined
    let closeAt: number | undefined
    for (const event of taskEvents) {
      const at = Date.parse(event.at)
      if (openAt === undefined && OPEN.has(event.type)) openAt = at
      if (closeAt === undefined && CLOSE.has(event.type)) closeAt = at
      if (RETRY.has(event.type)) retries += 1
    }
    if (openAt !== undefined && closeAt !== undefined && closeAt >= openAt) {
      leadTimes.push(closeAt - openAt)
    }
    if (openAt !== undefined && closeAt === undefined) {
      const last = Math.max(...taskEvents.map((event) => Date.parse(event.at)))
      if (maxAt - last > HOUR_MS) stuck += 1
    }
  }

  const sortedTimes = [...times].sort((a, b) => a - b)
  let idleGapMs = 0
  let transitions = 0
  for (let i = 1; i < sortedTimes.length; i++) {
    const gap = (sortedTimes[i] ?? 0) - (sortedTimes[i - 1] ?? 0)
    transitions += 1
    if (gap > IDLE_GRACE_MS) idleGapMs += gap
  }

  const sortedLead = [...leadTimes].sort((a, b) => a - b)
  return {
    leadTimeMedianMs: median(sortedLead),
    leadTimeP90Ms: percentile(sortedLead, 0.9),
    throughputPerDay: byTask.size / days,
    idleSeconds: transitions === 0 ? 0 : idleGapMs / transitions / 1000,
    retriesPerTask: retries / byTask.size,
    stuckPerWeek: stuck / (days / 7),
  }
}

const EventRow = Schema.Struct({ task_id: Schema.String, type: Schema.String, at: Schema.String })
const decodeEventRows = (rows: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(EventRow))(rows).pipe(Effect.orDie)

const TaskRow = Schema.Struct({
  retries: Schema.Int,
  manual_interventions: Schema.Int,
  tokens_in: Schema.NullOr(Schema.Int),
  tokens_out: Schema.NullOr(Schema.Int),
})
const decodeTaskRows = (rows: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(TaskRow))(rows).pipe(Effect.orDie)

const metricRows = (metrics: ProjectMetrics): ReadonlyArray<readonly [string, number]> => [
  ["lead_time_median_ms", metrics.leadTimeMedianMs ?? 0],
  ["lead_time_p90_ms", metrics.leadTimeP90Ms ?? 0],
  ["throughput_per_day", metrics.throughputPerDay],
  ["idle_seconds", metrics.idleSeconds],
  ["retries_per_task", metrics.retriesPerTask],
  ["stuck_per_week", metrics.stuckPerWeek],
]

// Computes and stores a baseline snapshot for one project (or "global"), over the last `windowDays`. Metrics from
// events (computeMetrics) plus the task-level tokens/task and % tasks without manual intervention. Each run
// appends a new snapshot (the window end is the run time), so baselines form a time series.
export const computeBaseline = (
  project: string,
  windowDays = 90,
): Effect.Effect<ReadonlyArray<BaselineRow>, SqlError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const windowTo = new Date().toISOString()
    const windowFrom = new Date(Date.now() - windowDays * DAY_MS).toISOString()

    const eventRows =
      project === "global"
        ? yield* sql`SELECT task_id, type, at FROM factory_events WHERE at >= ${windowFrom}`
        : yield* sql`SELECT e.task_id, e.type, e.at FROM factory_events e
            JOIN project_tasks t ON t.id = e.task_id AND t.source = e.source
            WHERE t.project = ${project} AND e.at >= ${windowFrom}`
    const taskRows =
      project === "global"
        ? yield* sql`SELECT retries, manual_interventions, tokens_in, tokens_out FROM project_tasks`
        : yield* sql`SELECT retries, manual_interventions, tokens_in, tokens_out FROM project_tasks
            WHERE project = ${project}`

    const events = (yield* decodeEventRows(eventRows)).map(({ task_id, type, at }) => ({
      taskId: task_id,
      type,
      at,
    }))
    const metrics = computeMetrics(events)
    const tasks = yield* decodeTaskRows(taskRows)

    let tokenSum = 0
    for (const task of tasks) {
      tokenSum += (task.tokens_in ?? 0) + (task.tokens_out ?? 0)
    }
    const tokensPerTask = tasks.length === 0 ? 0 : tokenSum / tasks.length
    const noInterventionPct =
      tasks.length === 0
        ? 0
        : (tasks.filter((task) => task.manual_interventions === 0).length / tasks.length) * 100

    const extraRows: ReadonlyArray<readonly [string, number]> = [
      ["tokens_per_task", tokensPerTask],
      ["no_intervention_pct", noInterventionPct],
    ]
    const rows: ReadonlyArray<BaselineRow> = [...metricRows(metrics), ...extraRows].map(
      ([metric, value]) => ({
        project,
        metric,
        value,
        windowFrom,
        windowTo,
      }),
    )

    for (const row of rows) {
      yield* sql`INSERT INTO baselines (project, metric, value, window_from, window_to, computed_at)
        VALUES (${row.project}, ${row.metric}, ${row.value}, ${row.windowFrom}, ${row.windowTo}, ${windowTo})`
    }
    return rows
  })
