import { type BeaconShape, costByTask } from "@shoalwork/beacon"
import type { BotRegistryShape } from "@shoalwork/bots"
import {
  type AgentMsg,
  type Artifact,
  type BotId,
  type Budget,
  BudgetExceeded,
  exceeds,
  type NotFound,
  PolicyDenied,
  type SchemaViolation,
  streamIds,
  type TaskId,
  TaskSpec,
  type Usage,
  type Verdict,
  ZERO_USAGE,
} from "@shoalwork/contracts"
import { Effect, Option, Schema, Semaphore, Stream } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import type { IntakeInput } from "./intake.js"
import type { TaskStoreShape } from "./tasks.js"
import { emit } from "./tasks.js"

// Agent messages a task may carry in its stream before further handoffs are refused (T-046, default of the core config).
export const MAX_AGENT_MSGS_PER_TASK = 20

// What a Bot hands over: the child's task-like spec and the parent it continues. The budget is a separate argument.
export type HandoffTask = Omit<IntakeInput, "botId" | "origin" | "parent" | "budget"> & {
  readonly parentTaskId: TaskId
}

export type HandoffOutcome =
  | { readonly _tag: "Created"; readonly child: TaskSpec }
  // The parent's stream reached the message limit: nothing was created. The verdict is the one the parent gets.
  | { readonly _tag: "Refused"; readonly verdict: Verdict }

export interface HandoffDeps {
  readonly beacon: BeaconShape
  readonly bots: Pick<BotRegistryShape, "get">
  readonly tasks: Pick<TaskStoreShape, "get">
  readonly intake: (spec: IntakeInput) => Effect.Effect<TaskSpec, SchemaViolation | NotFound | SqlError>
  readonly maxMessages?: number
}

const NO_COST = { tokensIn: 0, tokensOut: 0, usd: 0, seconds: 0 }

// The payload of task.received (the stored form of the task's spec).
const TaskReceivedPayload = Schema.Struct({ task: TaskSpec })

// What the parent task can still spend: its budget minus the usage its stream recorded. Never negative.
export const remainingBudget = (limit: Budget, used: Usage): Budget => ({
  tokens: Math.max(0, limit.tokens - (used.tokensIn + used.tokensOut)),
  seconds: Math.max(0, limit.seconds - used.seconds),
  usd: Math.max(0, limit.usd - used.usd),
})

// A handoff stays inside the room the parent has left. Returns the dimensions the child would overrun (none when fine).
export const overrunOf = (child: Budget, left: Budget): boolean => exceeds(child, left).exceeded

const streamIdOf = (taskId: TaskId): string => streamIds.task(taskId)

// Handoffs are rare and each one reads the parent's stream before it writes: one at a time keeps the message limit
// exact inside this process.
export const makeHandoff = (deps: HandoffDeps) => {
  const max = deps.maxMessages ?? MAX_AGENT_MSGS_PER_TASK
  const lock = Semaphore.makeUnsafe(1)

  const readStream = (taskId: TaskId) => Stream.runCollect(deps.beacon.readStream(streamIdOf(taskId)))

  // `from` must be the Bot that runs the parent task: a Bot hands work over only from its own task. Both Bots are
  // in the same registry, which is the one Lead's scope.
  const handoff = (
    from: BotId,
    to: BotId,
    taskLike: HandoffTask,
    budget: Budget,
  ): Effect.Effect<HandoffOutcome, NotFound | SchemaViolation | SqlError | PolicyDenied | BudgetExceeded> => {
    const { parentTaskId, ...rest } = taskLike
    return lock.withPermits(1)(
      Effect.gen(function* () {
        const parent = yield* deps.tasks.get(parentTaskId)
        if (parent.spec.botId !== from) {
          return yield* Effect.fail(
            new PolicyDenied({ botId: from, tool: "handoff", resource: parentTaskId }),
          )
        }
        yield* deps.bots.get(to)
        const events = yield* readStream(parentTaskId)
        const sent = events.filter((event) => event.type === "agent.msg").length
        if (sent >= max) {
          yield* emit(deps.beacon, {
            streamId: streamIdOf(parentTaskId),
            type: "error.raised",
            payload: {
              where: "lead.handoff",
              tag: "MessageLimit",
              message: "message limit",
              taskId: parentTaskId,
              botId: from,
            },
            actor: "system:lead",
            correlationId: parent.spec.correlationId ?? parentTaskId,
          })
          return {
            _tag: "Refused",
            verdict: {
              kind: "blocked",
              summary: "message limit",
              evidence: [`agent messages on the task: ${max}`],
              cost: NO_COST,
            },
          } satisfies HandoffOutcome
        }
        const used = costByTask(events).get(parentTaskId) ?? ZERO_USAGE
        const left = remainingBudget(parent.spec.budget, used)
        if (overrunOf(budget, left)) {
          return yield* Effect.fail(new BudgetExceeded({ scope: "task", limit: left, used: budget }))
        }
        const child = yield* deps.intake({
          ...rest,
          botId: to,
          origin: "bot",
          parent: { taskId: parentTaskId },
          budget,
        })
        const message: AgentMsg = { kind: "handoff", from, to, task: child, budget }
        yield* emit(deps.beacon, {
          streamId: streamIdOf(parentTaskId),
          type: "agent.msg",
          payload: message,
          actor: `bot:${from}`,
          correlationId: parent.spec.correlationId ?? parentTaskId,
        })
        return { _tag: "Created", child } satisfies HandoffOutcome
      }),
    )
  }

  // Who handed a task over: its parent task and the Bot that runs it, from the task's own task.received. Undefined
  // for a task that is not a handoff. The TaskStore is not read here, so a plain run costs one stream read.
  const handedOver = (
    childId: TaskId,
  ): Effect.Effect<{ readonly parentId: TaskId; readonly botId: BotId } | undefined, SqlError> =>
    readStream(childId).pipe(
      Effect.map((events) => {
        for (const event of events) {
          if (event.type !== "task.received") continue
          const decoded = Schema.decodeUnknownOption(TaskReceivedPayload)(event.payload)
          if (Option.isNone(decoded)) return undefined
          const { task } = decoded.value
          if (task.parent === undefined || !("taskId" in task.parent)) return undefined
          return { parentId: task.parent.taskId, botId: task.botId }
        }
        return undefined
      }),
    )

  // Puts the verdict of a settled child on its parent's stream. Idempotent: a child already reported (a redelivered
  // job) is not reported twice. Never fails: a problem is recorded in the log, the run's outcome stands.
  const reportChild = (
    childId: TaskId,
    verdict: Verdict,
    artifacts: ReadonlyArray<Artifact> = [],
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const link = yield* handedOver(childId)
      if (link === undefined) return
      const { parentId, botId } = link
      const events = yield* readStream(parentId)
      const already = events.some((event) => {
        if (event.type !== "agent.msg") return false
        const payload = event.payload
        return (
          typeof payload === "object" &&
          payload !== null &&
          "kind" in payload &&
          payload.kind === "result" &&
          "taskId" in payload &&
          payload.taskId === childId
        )
      })
      if (already) return
      const message: AgentMsg = {
        kind: "result",
        from: botId,
        taskId: childId,
        verdict,
        artifacts: [...artifacts],
      }
      yield* emit(deps.beacon, {
        streamId: streamIdOf(parentId),
        type: "agent.msg",
        payload: message,
        actor: `bot:${botId}`,
        correlationId: parentId,
      })
    }).pipe(
      Effect.catch((error) => Effect.logError(`handoff report failed: ${error._tag}`)),
      Effect.asVoid,
    )

  return { handoff, reportChild }
}
