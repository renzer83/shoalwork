import type { BeaconShape } from "@shoalwork/beacon"
import type { BotRegistryShape } from "@shoalwork/bots"
import {
  type Bot,
  EventPayloads,
  type ExecutorEvent,
  NotFound,
  type RepoRef,
  SchemaViolation,
  type StepId,
  streamIds,
  type TaskId,
  type TaskSpec,
  ZERO_USAGE,
} from "@shoalwork/contracts"
import type { TankShape } from "@shoalwork/tank"
import { Effect, Option, Schema, Stream } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import { redactSecrets } from "./narrator.js"
import { isTerminal } from "./outcomes.js"
import { continuationOf } from "./resume-request.js"
import { type Carry, tailOf, type Worktree } from "./retry.js"
import type { TaskRecord, TaskStoreShape } from "./tasks.js"
import { stepIdFor } from "./verdict.js"

export interface ResumeDeps {
  readonly tank: TankShape
  readonly bots: BotRegistryShape
}

// What a task that continues another one reads: the parent's events and store, and where a refusal is reported.
export interface ResumeSources extends ResumeDeps {
  readonly beacon: BeaconShape
  readonly tasks: TaskStoreShape
  readonly raiseError: (
    spec: Pick<TaskSpec, "id" | "botId">,
    where: string,
    tag: string,
    message: string,
  ) => Effect.Effect<void>
}

// A task continues another only when that task is this Bot's, has finished, and has no continuation under way. The
// parent's record comes back when there is one; a task without `resumeOf` is not checked. Refusals are the typed
// errors intake already answers with: an unknown or foreign parent is NotFound, the rest a SchemaViolation at resumeOf.
export const authorizeResume = (
  tasks: TaskStoreShape,
  spec: Pick<TaskSpec, "id" | "botId" | "resumeOf">,
): Effect.Effect<TaskRecord | undefined, NotFound | SchemaViolation | SqlError> =>
  Effect.gen(function* () {
    if (spec.resumeOf === undefined) {
      return undefined
    }
    const parent = yield* tasks.get(spec.resumeOf)
    if (parent.spec.botId !== spec.botId) {
      return yield* Effect.fail(new NotFound({ entity: "Task", id: spec.resumeOf }))
    }
    if (!isTerminal(parent.state)) {
      return yield* Effect.fail(new SchemaViolation({ where: "resumeOf", issue: { reason: "not-finished" } }))
    }
    const running = continuationOf(yield* tasks.listByBot(spec.botId), parent.spec.id, spec.id)
    if (running !== undefined) {
      return yield* Effect.fail(
        new SchemaViolation({
          where: "resumeOf",
          issue: { reason: "already-continued", running: running.spec.id },
        }),
      )
    }
    return parent
  })

// The worktree a step of the Bot left behind, when the Tank still has it and accepts the reuse. The reuse is proven
// before a run depends on it; the worktree is kept either way.
export const reusableWorktree = (deps: ResumeDeps, bot: Bot, repo: RepoRef, stepId: StepId) =>
  Effect.gen(function* () {
    const owned = yield* deps.tank.worktrees(bot, repo.url)
    const found = owned.find((worktree) => worktree.branch === `bot/${bot.name}/${stepId}`)
    if (found === undefined) {
      return undefined
    }
    const reuse: Worktree = { path: found.path, branch: found.branch }
    yield* deps.tank
      .prepare(bot, { stepId, repo, reuse })
      .pipe(Effect.flatMap((ctx) => deps.tank.release(ctx, { keepWorktree: true })))
    return reuse
  })

// A task found `running` when its job is delivered was interrupted by a restart (the boot recovery put the job back
// in the queue). It continues as a retry of the run it lost: same step, so the worktree and branch of that run, with
// the fallback flag so the attempt is not counted again. Returns undefined when it cannot continue (no worktree to
// reuse, or the Tank refuses it): the task then starts a fresh run.
export const recoveredCarry = (deps: ResumeDeps, record: TaskRecord): Effect.Effect<Carry | undefined> =>
  Effect.gen(function* () {
    if (record.state !== "running" || record.attempts < 1) {
      return undefined
    }
    const { spec } = record
    const stepId = stepIdFor(spec.id, record.attempts)
    const base: Carry = {
      stepId,
      worktree: undefined,
      sessionId: record.sessionId,
      tail: "",
      usage: ZERO_USAGE,
      fallback: true,
    }
    const repo = spec.repo
    if (repo === undefined) {
      return base
    }
    const bot = yield* deps.bots.get(spec.botId)
    const worktree = yield* reusableWorktree(deps, bot, repo, stepId)
    return worktree === undefined ? undefined : { ...base, worktree }
  }).pipe(Effect.orElseSucceed((): Carry | undefined => undefined))

// The events of a task that a continuation reads: the step its last run used, the lines of its last executor events
// (newest first, as the briefing keeps the newest when it cuts), and the text its last answer ended with.
const WORKING_EVENTS = 60
const decodeStarted = Schema.decodeUnknownOption(EventPayloads["executor.started"])
const decodeExecutorEvent = Schema.decodeUnknownOption(EventPayloads["executor.event"])

export interface ParentRun {
  readonly step: StepId | undefined
  readonly lines: ReadonlyArray<string>
  readonly lastText: string
}

// One line per event a reader can use; the rest (usage, thinking, approvals) are left out.
export const lineOf = (event: ExecutorEvent): string | undefined => {
  switch (event.kind) {
    case "text":
      return event.text
    case "command":
      return event.exitCode === undefined ? `$ ${event.cmd}` : `$ ${event.cmd} (exit ${event.exitCode})`
    case "file_edit":
      return `edited ${event.path}`
    case "tool_call":
      return `tool ${event.call.tool}`
    case "error":
      return `error ${event.code}: ${event.message}`
    case "done":
      return `done: ${event.result}`
    default:
      return undefined
  }
}

const parentRun = (deps: Pick<ResumeSources, "beacon">, taskId: TaskId) =>
  Effect.gen(function* () {
    const events = yield* Stream.runCollect(deps.beacon.readStream(streamIds.task(taskId), 0))
    let step: StepId | undefined
    const executorEvents: Array<ExecutorEvent> = []
    for (const event of events) {
      if (event.type === "executor.started") {
        const started = decodeStarted(event.payload)
        if (Option.isSome(started)) {
          step = started.value.stepId ?? step
        }
      } else if (event.type === "executor.event") {
        const payload = decodeExecutorEvent(event.payload)
        if (Option.isSome(payload)) {
          executorEvents.push(payload.value.event)
        }
      }
    }
    const recent = executorEvents.slice(-WORKING_EVENTS)
    const lines = [...recent].reverse().flatMap((event) => {
      const line = lineOf(event)
      return line === undefined ? [] : [line]
    })
    const lastText = executorEvents.reduce((text, event) => (event.kind === "text" ? event.text : text), "")
    return { step, lines, lastText } satisfies ParentRun
  })

// The carry of a task that continues another (`resumeOf`), in either state: not started yet, or recovered after a
// restart. The parent's own step (the one its last run used, read from its stream) is continued: its worktree when
// the Tank still has it, and the session of the task that ran there. A failed reuse, or a worktree that is gone, does
// not take the context: the run goes on on its own step with no session, and keeps the parent's lines and tail. A
// parent that cannot be continued is refused (error.raised) and the run starts fresh, with no carry.
const resumedCarry = (deps: ResumeSources, record: TaskRecord): Effect.Effect<Carry | undefined> =>
  Effect.gen(function* () {
    if (record.spec.resumeOf === undefined) {
      return undefined
    }
    const refuse = (tag: string, message: string) =>
      deps.raiseError(record.spec, "lead.resume", tag, message).pipe(Effect.as(undefined))
    const parent = yield* authorizeResume(deps.tasks, record.spec).pipe(
      Effect.catch((error) => refuse(error._tag, "the task to continue cannot be continued")),
    )
    if (parent === undefined) {
      return undefined
    }
    const run = yield* parentRun(deps, parent.spec.id).pipe(
      Effect.catch((error) => refuse(error._tag, "could not read the task to continue")),
    )
    if (run === undefined) {
      return undefined
    }
    const repo = parent.spec.repo
    const step = run.step
    // Only the worktree is at stake here: a reuse that fails is reported, and the context stays.
    const reuse =
      step === undefined || repo === undefined
        ? undefined
        : yield* Effect.gen(function* () {
            const bot = yield* deps.bots.get(record.spec.botId)
            return yield* reusableWorktree(deps, bot, repo, step)
          }).pipe(
            Effect.catch((error) =>
              deps
                .raiseError(
                  record.spec,
                  "lead.resume",
                  error._tag,
                  "could not reuse the worktree of the task",
                )
                .pipe(Effect.as(undefined)),
            ),
          )
    // Without a repo the parent's working directory is the same step; with one, the step needs its worktree.
    const continued = step !== undefined && (repo === undefined || reuse !== undefined)
    const own = stepIdFor(record.spec.id, Math.max(1, record.attempts))
    return {
      stepId: continued && step !== undefined ? step : own,
      worktree: reuse,
      sessionId: continued ? (record.sessionId ?? parent.sessionId) : undefined,
      tail: redactSecrets(tailOf(run.lastText)),
      usage: ZERO_USAGE,
      fallback: record.state === "running",
      working: run.lines,
    } satisfies Carry
  })

// The carry a run of this record starts from: a retry or recovery continues the run it lost, a task that resumes
// another continues the parent. Undefined when the run starts fresh.
export const carryFor = (deps: ResumeSources, record: TaskRecord): Effect.Effect<Carry | undefined> =>
  record.spec.resumeOf === undefined ? recoveredCarry(deps, record) : resumedCarry(deps, record)
