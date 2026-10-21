import type { BeaconShape } from "@shoalwork/beacon"
import {
  type ApprovalId,
  type BotId,
  type ExecutorId,
  ExecutorId as ExecutorIdSchema,
  NotFound,
  newApprovalId,
  newTaskId,
  streamIds,
  type TaskId,
  type TaskSpec,
  type TaskState,
  type Verdict,
} from "@shoalwork/contracts"
import type { LeadShape } from "@shoalwork/lead"
import type { ApprovalRecord, ApprovalsShape } from "@shoalwork/policy"
import { DateTime, Effect, Schema } from "effect"

export const CLAUDE = Schema.decodeUnknownSync(ExecutorIdSchema)("claude-code")
export const CODEX = Schema.decodeUnknownSync(ExecutorIdSchema)("codex")

type StoredTask = { spec: TaskSpec; state: TaskState; verdict?: Verdict }

const NO_COST = { tokensIn: 0, tokensOut: 0, usd: 0, seconds: 0 }

// A Lead that only stores tasks: the cycle talks to the Lead through intake, handoff and get, and the tests settle
// the tasks by hand (with the executor that "ran" them) instead of running anything. A handoff leaves the same
// agent.msg in the parent's stream that the real one does.
export const makeFakeLead = (beacon: BeaconShape) => {
  const store = new Map<TaskId, StoredTask>()
  const flags = { refuseHandoff: false, dieOn: undefined as TaskId | undefined, intakes: 0 }

  // What the real intake records first: the task, as received.
  const received = (spec: TaskSpec) =>
    beacon
      .append({
        streamId: streamIds.task(spec.id),
        type: "task.received",
        payload: { task: spec },
        actor: "system:lead",
        correlationId: spec.id,
      })
      .pipe(Effect.orDie)

  const lead: Pick<LeadShape, "intake" | "handoff" | "get"> = {
    intake: (input) =>
      Effect.gen(function* () {
        flags.intakes += 1
        const spec: TaskSpec = { ...input, tier: input.tier ?? "light", id: newTaskId() }
        store.set(spec.id, { spec, state: "ready" })
        yield* received(spec)
        return spec
      }),
    handoff: (from, to, taskLike, budget) =>
      Effect.gen(function* () {
        if (flags.refuseHandoff) {
          return {
            _tag: "Refused",
            verdict: { kind: "blocked", summary: "message limit", evidence: [], cost: NO_COST },
          } as const
        }
        const { parentTaskId, ...rest } = taskLike
        const child: TaskSpec = {
          ...rest,
          botId: to,
          budget,
          tier: "light",
          origin: "bot",
          parent: { taskId: parentTaskId },
          id: newTaskId(),
        }
        store.set(child.id, { spec: child, state: "ready" })
        yield* received(child)
        yield* beacon
          .append({
            streamId: streamIds.task(parentTaskId),
            type: "agent.msg",
            payload: { kind: "handoff", from, to, task: child, budget },
            actor: `bot:${from}`,
            correlationId: parentTaskId,
          })
          .pipe(Effect.orDie)
        return { _tag: "Created", child } as const
      }),
    get: (id) => {
      if (flags.dieOn === id) return Effect.die("lead exploded")
      const found = store.get(id)
      if (found === undefined) return Effect.fail(new NotFound({ entity: "Task", id }))
      return Effect.succeed({
        spec: found.spec,
        state: found.state,
        ...(found.verdict === undefined ? {} : { verdict: found.verdict }),
      })
    },
  }

  // Settles a task: its executor.started and final answer reach the log (the cycle reads both).
  const finish = (
    id: TaskId,
    outcome: {
      readonly executor?: ExecutorId
      readonly result?: string
      readonly kind?: Verdict["kind"]
      readonly evidence?: ReadonlyArray<string>
      readonly state?: TaskState
    } = {},
  ) =>
    Effect.gen(function* () {
      const found = store.get(id)
      if (found === undefined) return yield* Effect.die(`no task ${id}`)
      const verdict: Verdict = {
        kind: outcome.kind ?? "ok",
        summary: (outcome.result ?? "done").slice(0, 100),
        evidence: outcome.evidence ?? [],
        cost: NO_COST,
      }
      store.set(id, { spec: found.spec, state: outcome.state ?? "done", verdict })
      yield* beacon.append({
        streamId: streamIds.task(id),
        type: "executor.started",
        payload: {
          taskId: id,
          botId: found.spec.botId,
          executor: outcome.executor ?? CLAUDE,
          model: "m",
          cwd: "/tmp/w",
        },
        actor: "test",
        correlationId: id,
      })
      yield* beacon.append({
        streamId: streamIds.task(id),
        type: "executor.event",
        payload: {
          taskId: id,
          botId: found.spec.botId,
          event: { kind: "done", result: outcome.result ?? "done", artifacts: [] },
        },
        actor: "test",
        correlationId: id,
      })
    })

  const ofBot = (botId: BotId) => Array.from(store.values()).filter((entry) => entry.spec.botId === botId)

  return { lead, store, flags, finish, ofBot }
}

export const makeApprovals = () => {
  const records = new Map<ApprovalId, { record: ApprovalRecord; used: boolean }>()
  const approvals: Pick<ApprovalsShape, "request" | "get" | "consume"> = {
    request: (input) =>
      Effect.sync(() => {
        const record: ApprovalRecord = {
          id: newApprovalId(),
          taskId: input.taskId,
          botId: input.botId,
          action: input.action,
          risk: input.risk,
          status: "pending",
          requestedAt: DateTime.makeUnsafe(0),
          expiresAt: DateTime.makeUnsafe(1),
          actionHash: "hash",
          mode: input.mode ?? "resume",
        }
        records.set(record.id, { record, used: false })
        return record
      }),
    get: (id) => {
      const found = records.get(id)
      return found === undefined
        ? Effect.fail(new NotFound({ entity: "Approval", id }))
        : Effect.succeed(found.record)
    },
    consume: (id) =>
      Effect.sync(() => {
        const found = records.get(id)
        if (found === undefined || found.used) return false
        found.used = true
        return true
      }),
  }
  const decide = (status: "approved" | "denied") => {
    for (const entry of records.values()) entry.record = { ...entry.record, status }
  }
  return { approvals, records, decide }
}
