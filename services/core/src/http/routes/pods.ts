import {
  BotId,
  EventPayloads,
  NotFound,
  Plan,
  PlanId,
  PodId,
  TaskId,
  TaskSpec,
  TaskState,
} from "@shoalwork/contracts"
import { Effect, Option, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { Hono } from "hono"
import { failureResponse, type RouteResponse, type RunEffect, sendResponse } from "./respond.js"

// The Pods of the plans (T-049) as the app reads them (T-116). Read-only: the actions are the existing routes
// (POST /tasks/:id/stop, POST /control/pause). Steps are projected from `plans` and the step tasks (`parent.planId`).
const LIST_LIMIT = 100
const TEXT_MAX = 2000
const MESSAGE_LIMIT = 200
// "task_" is the prefix of a task id; the Pod name takes the six characters after it, as the topic name does.
const TASK_PREFIX_LENGTH = 5

export const StepState = Schema.Literals(["pending", ...TaskState.literals])
export type StepState = typeof StepState.Type

export interface StepUsage {
  readonly usd: number
  readonly tokensIn: number
  readonly tokensOut: number
}

export interface StepView {
  readonly id: string
  readonly title: string
  readonly state: StepState
  readonly botId: string | null
  readonly dependsOn: ReadonlyArray<string>
  readonly taskId: string | null
  readonly usage: StepUsage
}

const PodRow = Schema.Struct({
  id: PodId,
  task_id: TaskId,
  bot_ids: Schema.String,
  thread_id: Schema.Int,
  state: Schema.Literals(["open", "closed"]),
  created_at: Schema.String,
  closed_at: Schema.NullOr(Schema.String),
})
const PodRows = Schema.Array(PodRow)

const PlanRow = Schema.Struct({
  id: PlanId,
  plan: Schema.String,
  state: Schema.String,
})
const PlanRows = Schema.Array(PlanRow)

const StepTaskRow = Schema.Struct({
  id: TaskId,
  state: TaskState,
  spec: Schema.String,
})
const StepTaskRows = Schema.Array(StepTaskRow)

const UsageRow = Schema.Struct({ payload: Schema.String })
const UsageRows = Schema.Array(UsageRow)

const MessageRow = Schema.Struct({
  position: Schema.Int,
  stream_id: Schema.String,
  payload: Schema.String,
  occurred_at: Schema.String,
})
const MessageRows = Schema.Array(MessageRow)

const decodeUsage = Schema.decodeUnknownOption(EventPayloads["usage.recorded"])
const decodeAgentMsg = Schema.decodeUnknownOption(EventPayloads["agent.msg"])
const decodeSpec = Schema.decodeUnknownOption(TaskSpec)
const decodeBotIds = Schema.decodeUnknownOption(Schema.Array(BotId))

// Stored JSON is written by this core; an unreadable value is skipped, never a reason to fail a read.
const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

const clip = (text: string): string => (text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX - 1)}…` : text)

// Rows come from this module's own SQL; a shape mismatch is a bug, so it dies instead of becoming a typed error.
const rowsOf = <A>(schema: Schema.Decoder<A>, rows: ReadonlyArray<unknown>): Effect.Effect<A> =>
  Schema.decodeUnknownEffect(schema)(rows).pipe(Effect.orDie)

// The step tasks of a plan, oldest first, so the last one of a step is its latest attempt.
const stepTasksOf = (sql: SqlClient, planId: string) =>
  Effect.gen(function* () {
    const rows = yield* sql`SELECT id, state, spec FROM tasks
      WHERE json_extract(spec, '$.parent.planId') = ${planId} ORDER BY created_at ASC, rowid ASC`
    const decoded = yield* rowsOf(StepTaskRows, rows)
    return decoded.flatMap((row) => {
      const spec = decodeSpec(parseJson(row.spec))
      if (Option.isNone(spec) || spec.value.parent === undefined || !("stepId" in spec.value.parent)) {
        return []
      }
      return [{ taskId: row.id, state: row.state, stepId: spec.value.parent.stepId }]
    })
  })

// Usage events of the plan's tasks, summed per task id. Only usage.recorded carries the cost of a run.
const usageOf = (sql: SqlClient, planId: string) =>
  Effect.gen(function* () {
    const rows = yield* sql`SELECT payload FROM events WHERE type = 'usage.recorded'
      AND json_extract(payload, '$.taskId') IN (SELECT id FROM tasks WHERE json_extract(spec, '$.parent.planId') = ${planId})`
    const totals = new Map<string, StepUsage>()
    for (const row of yield* rowsOf(UsageRows, rows)) {
      const event = decodeUsage(parseJson(row.payload))
      if (Option.isNone(event)) continue
      const previous = totals.get(event.value.taskId) ?? { usd: 0, tokensIn: 0, tokensOut: 0 }
      totals.set(event.value.taskId, {
        usd: previous.usd + event.value.usage.usd,
        tokensIn: previous.tokensIn + event.value.usage.tokensIn,
        tokensOut: previous.tokensOut + event.value.usage.tokensOut,
      })
    }
    return totals
  })

const ZERO: StepUsage = { usd: 0, tokensIn: 0, tokensOut: 0 }

const addUsage = (a: StepUsage, b: StepUsage): StepUsage => ({
  usd: a.usd + b.usd,
  tokensIn: a.tokensIn + b.tokensIn,
  tokensOut: a.tokensOut + b.tokensOut,
})

// Each step takes the state and usage of its latest task; a step with no task yet is "pending".
export const projectSteps = (
  plan: Plan,
  tasks: ReadonlyArray<{ readonly taskId: string; readonly state: TaskState; readonly stepId: string }>,
  usage: ReadonlyMap<string, StepUsage>,
): ReadonlyArray<StepView> => {
  const latest = new Map<string, { readonly taskId: string; readonly state: TaskState }>()
  for (const task of tasks) latest.set(task.stepId, { taskId: task.taskId, state: task.state })
  return plan.steps.map((step): StepView => {
    const task = latest.get(step.id)
    const spent = tasks
      .filter((candidate) => candidate.stepId === step.id)
      .reduce((sum, candidate) => addUsage(sum, usage.get(candidate.taskId) ?? ZERO), ZERO)
    return {
      id: step.id,
      title: step.title,
      state: task?.state ?? "pending",
      botId: step.assignedBot ?? null,
      dependsOn: step.dependsOn,
      taskId: task?.taskId ?? null,
      usage: spent,
    }
  })
}

// One message per agent.msg event of a step task: a handoff names the task, a result its summary, a status its note.
export interface MessageView {
  readonly position: number
  readonly occurredAt: string
  readonly taskId: string
  readonly stepId: string | null
  readonly botId: string
  readonly kind: "handoff" | "result" | "status"
  readonly text: string
}

const messagesOf = (
  rows: ReadonlyArray<typeof MessageRow.Type>,
  stepOf: ReadonlyMap<string, string>,
): ReadonlyArray<MessageView> =>
  rows.flatMap((row): ReadonlyArray<MessageView> => {
    const decoded = decodeAgentMsg(parseJson(row.payload))
    if (Option.isNone(decoded)) return []
    const msg = decoded.value
    const taskId = row.stream_id.slice("task:".length)
    const base = {
      position: row.position,
      occurredAt: row.occurred_at,
      taskId,
      stepId: stepOf.get(taskId) ?? null,
    }
    if (msg.kind === "handoff") {
      return [{ ...base, botId: msg.from, kind: msg.kind, text: clip(msg.task.title) }]
    }
    if (msg.kind === "result") {
      return [{ ...base, botId: msg.from, kind: msg.kind, text: clip(msg.verdict.summary) }]
    }
    return [{ ...base, botId: msg.bot, kind: msg.kind, text: clip(msg.note ?? msg.state) }]
  })

const planOf = (sql: SqlClient, taskId: string) =>
  Effect.gen(function* () {
    const rows = yield* sql`SELECT id, plan, state FROM plans WHERE task_id = ${taskId}`
    const [row] = yield* rowsOf(PlanRows, rows)
    if (row === undefined) return undefined
    const plan = yield* Schema.decodeUnknownEffect(Plan)(parseJson(row.plan)).pipe(Effect.orDie)
    return { row, plan }
  })

const podView = (row: typeof PodRow.Type) => {
  const botIds = Option.getOrElse(decodeBotIds(parseJson(row.bot_ids)), () => [])
  return {
    id: row.id,
    taskId: row.task_id,
    name: `pod-${row.task_id.slice(TASK_PREFIX_LENGTH, TASK_PREFIX_LENGTH + 6)}`,
    state: row.state,
    threadId: row.thread_id,
    botIds,
    createdAt: row.created_at,
    closedAt: row.closed_at,
  }
}

const listPods = (rawState: string | undefined) =>
  Effect.gen(function* () {
    if (rawState !== undefined && rawState !== "open" && rawState !== "closed") {
      return { status: 400, body: { error: "invalid query", param: "state" } } satisfies RouteResponse
    }
    const sql = yield* SqlClient
    const state = rawState ?? null
    const rows = yield* sql`SELECT * FROM pods WHERE (${state} IS NULL OR state = ${state})
      ORDER BY created_at DESC, rowid DESC LIMIT ${LIST_LIMIT}`
    const pods = yield* rowsOf(PodRows, rows)
    const summaries = yield* Effect.forEach(pods, (row) =>
      Effect.gen(function* () {
        const found = yield* planOf(sql, row.task_id)
        const steps =
          found === undefined
            ? []
            : projectSteps(
                found.plan,
                yield* stepTasksOf(sql, found.row.id),
                yield* usageOf(sql, found.row.id),
              )
        return {
          ...podView(row),
          stepsDone: steps.filter((step) => step.state === "done").length,
          stepsTotal: steps.length,
          costUsd: steps.reduce((sum, step) => sum + step.usage.usd, 0),
        }
      }),
    )
    return { status: 200, body: { pods: summaries } } satisfies RouteResponse
  }).pipe(Effect.catch(failureResponse))

// A malformed id cannot name a stored Pod, so it answers 404 like an unknown one.
const readPod = (rawId: string) =>
  Effect.gen(function* () {
    const id = yield* Schema.decodeUnknownEffect(PodId)(rawId).pipe(
      Effect.mapError(() => new NotFound({ entity: "Pod", id: rawId })),
    )
    const sql = yield* SqlClient
    const rows = yield* sql`SELECT * FROM pods WHERE id = ${id}`
    const [row] = yield* rowsOf(PodRows, rows)
    if (row === undefined) {
      return yield* Effect.fail(new NotFound({ entity: "Pod", id }))
    }
    const found = yield* planOf(sql, row.task_id)
    const stepTasks = found === undefined ? [] : yield* stepTasksOf(sql, found.row.id)
    const usage = found === undefined ? new Map<string, StepUsage>() : yield* usageOf(sql, found.row.id)
    const steps = found === undefined ? [] : projectSteps(found.plan, stepTasks, usage)
    const stepOf = new Map(stepTasks.map((task) => [task.taskId, task.stepId] as const))
    const messageRows = yield* sql`SELECT position, stream_id, payload, occurred_at FROM events
      WHERE type = 'agent.msg' AND stream_id IN (
        SELECT 'task:' || id FROM tasks WHERE json_extract(spec, '$.parent.planId') = ${found?.row.id ?? null})
      ORDER BY position DESC LIMIT ${MESSAGE_LIMIT}`
    const messages = [...messagesOf(yield* rowsOf(MessageRows, messageRows), stepOf)].reverse()
    const body = {
      pod: podView(row),
      plan: found === undefined ? null : { id: found.row.id, taskId: row.task_id, state: found.row.state },
      steps,
      messages,
    }
    return { status: 200, body } satisfies RouteResponse
  }).pipe(Effect.catch(failureResponse))

export const registerPodRoutes = (app: Hono, runEffect: RunEffect): void => {
  app.get("/pods", async (c) => sendResponse(c, await runEffect(listPods(c.req.query("state")))))
  app.get("/pods/:id", async (c) => sendResponse(c, await runEffect(readPod(c.req.param("id")))))
}
