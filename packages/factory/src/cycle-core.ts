import { type BeaconShape, costByTask } from "@shoalwork/beacon"
import type { BotRegistryShape } from "@shoalwork/bots"
import {
  AgentMsg,
  type Budget,
  type Conflict,
  type NotFound,
  type SchemaViolation,
  streamIds,
  type TaskId,
  TaskId as TaskIdSchema,
  type TaskSpec,
  ZERO_USAGE,
} from "@shoalwork/contracts"
import type { GhClientShape } from "@shoalwork/currents"
import { type HandoffTask, type LeadShape, remainingBudget } from "@shoalwork/lead"
import type { ApprovalsShape, PolicyShape } from "@shoalwork/policy"
import { Effect, Option, Schema, Stream } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import { minBudget } from "./cycle-text.js"
import type { KanbanShape } from "./kanban.js"
import type { TaskRow } from "./kanban-rows.js"

// What every phase of the delivery cycle (T-061) shares: the services it talks to, a move of the board, the block of
// a task that cannot go on, and the handoff to another Bot. The phases live in cycle-dispatch / -gates / -merge.
export interface CycleDeps {
  readonly sql: SqlClient
  readonly beacon: BeaconShape
  readonly kanban: KanbanShape
  readonly lead: Pick<LeadShape, "intake" | "handoff" | "get">
  readonly bots: Pick<BotRegistryShape, "getByName">
  readonly gh: GhClientShape
  readonly policy?: Pick<PolicyShape, "evaluate"> | undefined
  readonly approvals?: Pick<ApprovalsShape, "request" | "get" | "consume"> | undefined
}

export type BoardState = Parameters<KanbanShape["move"]>[0]["to"]
export type BlockError = Conflict | NotFound | SchemaViolation | SqlError

export const SETTLED_LEAD: ReadonlySet<string> = new Set(["done", "failed", "cancelled"])

const decodeMsg = Schema.decodeUnknownOption(AgentMsg)

export const makeKit = (deps: CycleDeps) => {
  const { sql, beacon, kanban, lead, bots } = deps

  const leadId = (raw: string): Effect.Effect<TaskId> =>
    Schema.decodeUnknownEffect(TaskIdSchema)(raw).pipe(Effect.orDie)

  // A move of the board by the system. False when the board refuses it (the WIP limit, or the task moved already).
  const move = (project: string, taskId: string, to: BoardState, reason: string) =>
    kanban.move({ project, taskId, to, reason, actor: "system" }).pipe(
      Effect.as(true),
      Effect.catchTag("Conflict", () => Effect.succeed(false)),
    )

  // The task cannot go on: blocked on the board, the cycle closed, and a warning in the project's stream.
  const block = (
    project: string,
    task: Pick<TaskRow, "id">,
    reason: string,
    lastTask?: string,
  ): Effect.Effect<void, BlockError> =>
    Effect.gen(function* () {
      yield* move(project, task.id, "blocked", reason)
      yield* sql`UPDATE project_cycles SET phase = 'settled' WHERE project = ${project} AND task_id = ${task.id}`
      const ref = lastTask === undefined ? undefined : yield* leadId(lastTask)
      yield* beacon.append({
        streamId: streamIds.project(project),
        type: "error.raised",
        payload: {
          where: "factory.cycle",
          tag: "Blocked",
          message: `${task.id}: ${reason}`.slice(0, 300),
          ...(ref === undefined ? {} : { taskId: ref }),
        },
        actor: "system:factory",
        correlationId: task.id,
      })
    })

  // Domain failures of a Lead call block the task; a database failure goes up to the caller.
  const orBlock =
    (project: string, task: Pick<TaskRow, "id">, what: string) =>
    <A, E extends { readonly _tag: string }>(
      effect: Effect.Effect<A, E>,
    ): Effect.Effect<A | undefined, E | BlockError> =>
      effect.pipe(
        Effect.catch(
          (error): Effect.Effect<A | undefined, E | BlockError> =>
            error._tag === "SqlError"
              ? Effect.fail(error)
              : block(project, task, `${what}: ${error._tag}`).pipe(Effect.as(undefined)),
        ),
      )

  // What a child may spend: the Bot's budget, cut to what its parent has left.
  const budgetFor = (parent: TaskId, parentBudget: Budget, own: Budget) =>
    Effect.gen(function* () {
      const events = yield* Stream.runCollect(beacon.readStream(streamIds.task(parent)))
      const used = costByTask(Array.from(events)).get(parent) ?? ZERO_USAGE
      return minBudget(own, remainingBudget(parentBudget, used))
    })

  // The child a Bot already handed over for this board task: a handoff carries its child in the parent's stream, so a
  // pass that crashed after the handoff finds it instead of creating a second one.
  const existingChild = (parent: TaskId, to: TaskSpec["botId"], correlation: string) =>
    Effect.gen(function* () {
      const events = Array.from(yield* Stream.runCollect(beacon.readStream(streamIds.task(parent))))
      for (const event of events) {
        if (event.type !== "agent.msg") continue
        const msg = decodeMsg(event.payload)
        if (Option.isNone(msg) || msg.value.kind !== "handoff") continue
        if (msg.value.to === to && msg.value.task.correlationId === correlation) return msg.value.task
      }
      return undefined
    })

  // A handoff from the Bot that ran `parentId` to `<role>-<project>`: the child task (the one already handed over,
  // if any), or undefined when the parent's message limit refused it.
  const handTo = (
    project: string,
    parentId: string,
    role: string,
    correlation: string,
    input: Omit<HandoffTask, "parentTaskId" | "correlationId">,
  ) =>
    Effect.gen(function* () {
      const parentTask = yield* leadId(parentId)
      const to = yield* bots.getByName(`${role}-${project}`)
      const found = yield* existingChild(parentTask, to.id, correlation)
      if (found !== undefined) return found
      const parent = yield* lead.get(parentTask)
      const budget = yield* budgetFor(parentTask, parent.spec.budget, to.budget)
      const outcome = yield* lead.handoff(
        parent.spec.botId,
        to.id,
        { ...input, parentTaskId: parentTask, correlationId: correlation },
        budget,
      )
      return outcome._tag === "Created" ? outcome.child : undefined
    })

  return { deps, leadId, move, block, orBlock, handTo }
}

export type Kit = ReturnType<typeof makeKit>
