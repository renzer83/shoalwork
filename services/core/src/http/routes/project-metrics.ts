import { Beacon } from "@shoalwork/beacon"
import { ProjectTaskStateChangedPayload, streamIds } from "@shoalwork/contracts"
import { computeMetrics, Kanban, type MetricEvent, type ProjectMetrics } from "@shoalwork/factory"
import { Effect, Option, Schema, Stream } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { Hono } from "hono"
import { failureResponse, type RouteResponse, type RunEffect, sendResponse } from "./respond.js"

// The six measures of index.md §2.3 that the board shows, each with the goal it is judged against.
export type GoalKey =
  | "lead_time_median_ms"
  | "throughput_per_day"
  | "tokens_per_task"
  | "no_intervention_pct"
  | "idle_seconds"
  | "stuck_per_week"

export interface GoalRow {
  readonly key: GoalKey
  readonly label: string
  readonly target: string
  readonly current: number | null
  readonly baseline: number | null
  readonly met: boolean | null
}

interface Goal {
  readonly key: GoalKey
  readonly label: string
  readonly target: string
  readonly met: (current: number, baseline: number | null) => boolean
}

export const GOALS: ReadonlyArray<Goal> = [
  {
    key: "lead_time_median_ms",
    label: "Lead time (median)",
    target: "≤ 50% of baseline",
    met: (current, baseline) => baseline !== null && current <= baseline * 0.5,
  },
  {
    key: "throughput_per_day",
    label: "Throughput per day",
    target: "≥ 3× baseline",
    met: (current, baseline) => baseline !== null && current >= baseline * 3,
  },
  {
    key: "tokens_per_task",
    label: "Tokens per task",
    target: "≤ 60% of baseline",
    met: (current, baseline) => baseline !== null && current <= baseline * 0.6,
  },
  {
    key: "no_intervention_pct",
    label: "Tasks without manual intervention",
    target: "≥ 90%",
    met: (current) => current >= 90,
  },
  { key: "idle_seconds", label: "Idle per transition", target: "< 60 s", met: (current) => current < 60 },
  {
    key: "stuck_per_week",
    label: "Stuck tasks (> 1 h) per week",
    target: "0",
    met: (current) => current === 0,
  },
]

// One state change of a task on the board, as the log holds it.
export interface BoardTransition {
  readonly taskId: string
  readonly to: string
  readonly reason: string | undefined
  readonly at: string
}

const kindOf = (transition: BoardTransition): string => {
  if (transition.to === "done") return "merged"
  if (transition.reason === "retry") return "retry"
  return "transition"
}

// Pure: the board's transitions as the events computeMetrics reads. The first transition of a task opens it.
// Cancelled tasks are left out: they never close and would read as stuck. Every transition is an event, so the
// idle time measures the gaps between all of them.
export const boardMetricEvents = (
  transitions: ReadonlyArray<BoardTransition>,
): ReadonlyArray<MetricEvent> => {
  const last = new Map<string, string>()
  for (const transition of transitions) {
    last.set(transition.taskId, transition.to)
  }
  const opened = new Set<string>()
  const events: Array<MetricEvent> = []
  for (const transition of transitions) {
    if (last.get(transition.taskId) === "cancelled") continue
    const first = !opened.has(transition.taskId)
    opened.add(transition.taskId)
    events.push({
      taskId: transition.taskId,
      type: first ? "opened" : kindOf(transition),
      at: transition.at,
    })
    if (first && transition.to === "done") {
      events.push({ taskId: transition.taskId, type: "merged", at: transition.at })
    }
  }
  return events
}

export type Measures = Readonly<Record<GoalKey, number | null>>

// Pure: each goal with its current value, the baseline value and whether the goal is met (null without data).
export const goalRows = (
  current: Measures,
  baseline: Readonly<Partial<Record<GoalKey, number>>>,
): ReadonlyArray<GoalRow> =>
  GOALS.map((goal) => {
    const now = current[goal.key]
    const base = baseline[goal.key] ?? null
    return {
      key: goal.key,
      label: goal.label,
      target: goal.target,
      current: now,
      baseline: base,
      met: now === null ? null : goal.met(now, base),
    }
  })

const goalKeyOf = (raw: string): GoalKey | undefined => GOALS.find((goal) => goal.key === raw)?.key

const readTransitions = (project: string) =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    const streamId = streamIds.project(project)
    const events = yield* Stream.runCollect(
      beacon
        .readAll(0, ["project_task.state_changed"])
        .pipe(Stream.filter((event) => event.streamId === streamId)),
    ).pipe(Effect.orDie)
    const transitions: Array<BoardTransition> = []
    for (const event of events) {
      const payload = Option.getOrUndefined(
        Schema.decodeUnknownOption(ProjectTaskStateChangedPayload)(event.payload),
      )
      if (payload !== undefined) {
        transitions.push({
          taskId: payload.taskId,
          to: payload.to,
          reason: payload.reason,
          at: Schema.encodeSync(Schema.DateTimeUtcFromString)(event.occurredAt),
        })
      }
    }
    return transitions
  })

interface TokenRow {
  readonly tokens_in: number | null
  readonly tokens_out: number | null
}

interface BaselineDbRow {
  readonly metric: string
  readonly value: number
  readonly window_to: string
}

// Current values from the board, judged against the latest baseline snapshot of the project (computeBaseline).
const compare = (project: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const tasks = yield* (yield* Kanban).listTasks(project)
    const tokenRows =
      yield* sql<TokenRow>`SELECT tokens_in, tokens_out FROM project_tasks WHERE project = ${project}`
    const transitions = yield* readTransitions(project)
    const baselineRows = yield* sql<BaselineDbRow>`SELECT metric, value, window_to FROM baselines
      WHERE project = ${project}
        AND window_to = (SELECT MAX(window_to) FROM baselines WHERE project = ${project})`

    const measured = transitions.length > 0
    const metrics: ProjectMetrics = computeMetrics(boardMetricEvents(transitions))
    const measure = (value: number): number | null => (measured ? value : null)
    const hasTokens = tokenRows.some((row) => row.tokens_in !== null || row.tokens_out !== null)
    const tokenSum = tokenRows.reduce((sum, row) => sum + (row.tokens_in ?? 0) + (row.tokens_out ?? 0), 0)
    const current: Measures = {
      lead_time_median_ms: metrics.leadTimeMedianMs,
      throughput_per_day: measure(metrics.throughputPerDay),
      tokens_per_task: hasTokens ? tokenSum / tokenRows.length : null,
      no_intervention_pct:
        tasks.length === 0
          ? null
          : (tasks.filter((task) => task.manualInterventions === 0).length / tasks.length) * 100,
      idle_seconds: measure(metrics.idleSeconds),
      stuck_per_week: measure(metrics.stuckPerWeek),
    }

    const baseline: Partial<Record<GoalKey, number>> = {}
    for (const row of baselineRows) {
      const key = goalKeyOf(row.metric)
      if (key !== undefined) baseline[key] = row.value
    }
    return {
      status: 200,
      body: { project, baselineAt: baselineRows[0]?.window_to ?? null, rows: goalRows(current, baseline) },
    } satisfies RouteResponse
  }).pipe(Effect.catch(failureResponse))

export const registerMetricRoutes = (app: Hono, runEffect: RunEffect): void => {
  app.get("/metrics/compare", async (c) => {
    const project = c.req.query("project")
    if (project === undefined || project === "") {
      return c.json({ error: "invalid request", where: "project" }, 400)
    }
    return sendResponse(c, await runEffect(compare(project)))
  })
}
