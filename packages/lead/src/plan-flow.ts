import type { BeaconShape } from "@shoalwork/beacon"
import type { BotRegistryShape } from "@shoalwork/bots"
import type { BotId, Plan, TaskId, TaskSpec } from "@shoalwork/contracts"
import { Cause, Effect } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import type { ControlShape, RunHandle } from "./control.js"
import { makeLifecycle } from "./lifecycle.js"
import type { Dispatcher } from "./plan/dispatcher.js"
import type { PlanOutcome, PlanSignals } from "./plan/planner.js"
import { shouldPlan } from "./plan/planner.js"
import { planVerdict, sumCost } from "./plan-verdict.js"
import type { Pods } from "./pods.js"
import type { RunResult } from "./runner.js"
import type { TaskStoreShape } from "./tasks.js"
import { blockedVerdict, clip, describeFailure, isSettled, settledResult, stoppedVerdict } from "./verdict.js"

export interface PlanFlowDeps {
  readonly sql: SqlClient
  readonly beacon: BeaconShape
  readonly tasks: TaskStoreShape
  readonly bots: BotRegistryShape
  readonly control: Pick<ControlShape, "track">
  readonly planner: {
    readonly plan: (task: TaskSpec, signals: PlanSignals) => Effect.Effect<PlanOutcome, unknown>
  }
  readonly pods: Pick<Pods, "open" | "close">
  readonly dispatcher: Dispatcher
  readonly signalsOf: (spec: TaskSpec) => Effect.Effect<PlanSignals, unknown>
  // The ordinary run of a task (Lead.runTask): everything the flow does not plan.
  readonly runTask: (id: TaskId) => Effect.Effect<RunResult>
}

export const PLAN_RESTART_REASON = "process restarted during plan"
const PLAN_ENDED_REASON = "plan ended"
const SUMMARY_MAX = 300

type PlannedOutcome = Extract<PlanOutcome, { kind: "planned" }>

// Planner -> Pod -> Dispatcher for a task that needs a plan; any other task runs as always. The root task ends with
// the state of its plan: done (ok verdict, PR as evidence), failed, or cancelled by a stop. A problem becomes a
// verdict; it is left unrecorded only when the task could not be closed, so the job is delivered again.
export const makePlanFlow = (deps: PlanFlowDeps) => {
  const { sql, beacon, tasks, bots, control, pods } = deps
  const lifecycle = makeLifecycle({ beacon, tasks, bots })

  // Closes the root with the verdict and frees its Bot (the root ran no executor, so `finish` never sees it).
  const closeRoot = (spec: TaskSpec, state: "done" | "failed", verdict: RunResult["verdict"], why: string) =>
    Effect.gen(function* () {
      yield* lifecycle.transition(spec, state, { verdict }, why)
      yield* lifecycle.recordOutcomes(spec, state)
      yield* lifecycle.freeBot(spec)
      return { verdict, recorded: true, stopped: false } satisfies RunResult
    })

  const stopped = (spec: TaskSpec, by: string) =>
    lifecycle
      .cancelUnstarted(spec, by)
      .pipe(Effect.as({ verdict: stoppedVerdict(by), recorded: true, stopped: true } satisfies RunResult))

  // Every task the plan's steps created (all attempts), found through the Bots of the Pod.
  const planTasks = (botIds: ReadonlyArray<BotId>, planId: string) =>
    Effect.gen(function* () {
      const found = yield* Effect.forEach(botIds, (botId) => tasks.listByBot(botId))
      return found.flat().filter((record) => {
        const parent = record.spec.parent
        return parent !== undefined && "planId" in parent && parent.planId === planId
      })
    })

  // What the plan left open (an interruption, a failed dispatcher) is cancelled, then the Pod closes. A Pod that
  // cannot close (a step still running elsewhere) stays open and is reported.
  const wrapUp = (
    spec: TaskSpec,
    plan: Plan,
    pod: { readonly id: Parameters<Pods["close"]>[0]; readonly botIds: ReadonlyArray<BotId> },
  ) =>
    Effect.gen(function* () {
      const open = (yield* planTasks(pod.botIds, plan.id)).filter((record) => !isSettled(record.state))
      yield* Effect.forEach(open, (record) => lifecycle.cancelUnstarted(record.spec, PLAN_ENDED_REASON), {
        discard: true,
      })
      yield* pods.close(pod.id, { planFinished: true })
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : lifecycle.raiseError(
              spec,
              "lead.plan",
              describeFailure(Cause.squash(cause)).tag,
              "pod not closed",
            ),
      ),
    )

  const dispatch = (spec: TaskSpec, plan: Plan, handle: RunHandle) =>
    Effect.gen(function* () {
      yield* lifecycle.transition(spec, "running", {}, "plan dispatch")
      const { pod, assignments } = yield* pods.open(plan)
      const raced = yield* Effect.raceFirst(
        deps.dispatcher.run(plan, assignments).pipe(Effect.map((run) => ({ _tag: "Ran" as const, run }))),
        handle.stopRequested.pipe(Effect.map((by) => ({ _tag: "Stopped" as const, by }))),
      ).pipe(Effect.ensuring(wrapUp(spec, plan, pod)))
      if (raced._tag === "Stopped") return yield* stopped(spec, raced.by)
      const titles = new Map<string, string>(plan.steps.map((step) => [step.id, step.title]))
      const records = yield* planTasks(pod.botIds, plan.id)
      const cost = sumCost(
        records.flatMap((record) => (record.verdict === undefined ? [] : [record.verdict.cost])),
      )
      const verdict = planVerdict(raced.run, titles, cost)
      const state = verdict.kind === "ok" ? "done" : "failed"
      return yield* closeRoot(spec, state, verdict, state === "done" ? "plan done" : "plan failed")
    })

  // Plans the task, then dispatches the plan. The root is tracked for the whole time, so a stop reaches it while
  // the model drafts the plan too. Resolves undefined when the planner says there is nothing to plan.
  const plannedRun = (spec: TaskSpec, signals: PlanSignals) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* control.track(spec.id, spec.botId)
        const current = yield* tasks.get(spec.id)
        if (isSettled(current.state)) return settledResult(current)
        if (yield* handle.isStopped) return yield* stopped(spec, yield* handle.stopRequested)
        const drafted = yield* Effect.raceFirst(
          deps.planner
            .plan(spec, signals)
            .pipe(Effect.map((outcome) => ({ _tag: "Done" as const, outcome }))),
          handle.stopRequested.pipe(Effect.map((by) => ({ _tag: "Stopped" as const, by }))),
        )
        if (drafted._tag === "Stopped") return yield* stopped(spec, drafted.by)
        const outcome = drafted.outcome
        if (outcome.kind === "skipped") return undefined
        if (outcome.kind === "blocked") {
          yield* lifecycle.freeBot(spec)
          return { verdict: outcome.verdict, recorded: true, stopped: false } satisfies RunResult
        }
        // A stop that got in between (by any path) leaves the task as it set it: the plan is not run over it.
        const after = yield* tasks.get(spec.id)
        if (after.state !== "ready") return settledResult(after)
        return yield* dispatch(spec, (outcome satisfies PlannedOutcome).plan, handle)
      }),
    ).pipe(
      Effect.flatMap((result) => (result === undefined ? deps.runTask(spec.id) : Effect.succeed(result))),
    )

  // A task with a stored plan that is not settled was left by a process that died (or lost its lock) mid-plan. It
  // does not run as an ordinary task: its Pod closes and the task ends blocked.
  const restarted = (spec: TaskSpec) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly id: string; readonly bot_ids: string }>`
        SELECT id, bot_ids FROM pods WHERE task_id = ${spec.id} AND state = 'open'`
      for (const row of rows) {
        yield* pods
          .close(row.id as Parameters<Pods["close"]>[0], { planFinished: true })
          .pipe(
            Effect.catch((error) =>
              lifecycle.raiseError(spec, "lead.plan", describeFailure(error).tag, "pod not closed"),
            ),
          )
      }
      yield* lifecycle.raiseError(spec, "lead.plan", "PlanRestarted", PLAN_RESTART_REASON)
      const verdict = blockedVerdict(PLAN_RESTART_REASON, PLAN_RESTART_REASON)
      return yield* closeRoot(spec, "failed", verdict, PLAN_RESTART_REASON)
    })

  // Any failure after the task entered planning ends it: it will not plan again.
  const failFlow = (spec: TaskSpec, cause: Cause.Cause<unknown>): Effect.Effect<RunResult> => {
    if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
    const { tag, message } = describeFailure(Cause.squash(cause))
    const verdict = blockedVerdict(clip(`plan flow failed: ${tag}: ${message}`, SUMMARY_MAX), tag)
    return closeRoot(spec, "failed", verdict, "plan flow failed").pipe(
      Effect.catchCause(() =>
        Effect.succeed({ verdict, recorded: false, stopped: false } satisfies RunResult),
      ),
    )
  }

  const hasPlan = (id: TaskId) =>
    Effect.map(sql`SELECT 1 AS n FROM plans WHERE task_id = ${id} LIMIT 1`, (rows) => rows.length > 0)

  const run = (id: TaskId): Effect.Effect<RunResult> =>
    Effect.gen(function* () {
      const { spec, state } = yield* deps.tasks.get(id)
      const ownedByPlan = spec.parent !== undefined && "planId" in spec.parent
      // Step tasks and settled tasks (an approval wait included) go the ordinary way.
      if (ownedByPlan || isSettled(state)) return yield* deps.runTask(id)
      if (yield* hasPlan(id))
        return yield* restarted(spec).pipe(Effect.catchCause((cause) => failFlow(spec, cause)))
      if (state !== "received" && state !== "planning") return yield* deps.runTask(id)
      const signals = yield* deps
        .signalsOf(spec)
        .pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("plan signals unavailable", describeFailure(Cause.squash(cause)).tag).pipe(
                  Effect.as({} as PlanSignals),
                ),
          ),
        )
      if (!shouldPlan(spec, signals)) return yield* deps.runTask(id)
      return yield* plannedRun(spec, signals).pipe(Effect.catchCause((cause) => failFlow(spec, cause)))
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
        // The task could not even be read: not recorded, so the job is delivered again.
        const { tag, message } = describeFailure(Cause.squash(cause))
        return Effect.succeed({
          verdict: blockedVerdict(clip(`${tag}: ${message}`, SUMMARY_MAX), tag),
          recorded: false,
          stopped: false,
        } satisfies RunResult)
      }),
    )

  return { run }
}

export type PlanFlow = ReturnType<typeof makePlanFlow>
