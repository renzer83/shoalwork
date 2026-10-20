import type { BotId, Budget, ExecutorId, Plan, TaskId, TaskSpec, Verdict } from "@shoalwork/contracts"
import { Effect, Ref } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import { type Attempt, conflictOf, type Job } from "./step-outcome.js"
import { branchOf, createStepTask, type StepTaskDeps } from "./step-task.js"

// The reason the dispatcher gives for closing the task of a step an interruption left unfinished.
export const PLAN_STOPPED_REASON = "plan stopped"

// What running a task came back with: its verdict and whether a stop (not the task itself) ended it.
// The runner's RunResult has both (Lead.runTask).
export interface StepResult {
  readonly verdict: Verdict
  readonly stopped: boolean
}

export interface RunOnceDeps extends StepTaskDeps {
  readonly runTask: (id: TaskId) => Effect.Effect<StepResult>
  readonly abandon: (id: TaskId, reason: string) => Effect.Effect<void>
  readonly overBudget: (botId: BotId) => Effect.Effect<boolean, SqlError>
}

// One run of a step as its own task. An interruption closes the task unless it already has its verdict.
// `stopped` is set once a run comes back stopped: from then on no task is created.
export const makeRunOnce =
  (env: {
    readonly deps: RunOnceDeps
    readonly root: TaskSpec
    readonly plan: Plan
    readonly stopped: Ref.Ref<boolean>
  }) =>
  (
    { step, botId }: Job,
    base: string,
    prompt: string,
    runs: number,
    budget: Budget,
    exclude?: ReadonlyArray<ExecutorId>,
  ): Effect.Effect<Attempt, SqlError> =>
    Effect.gen(function* () {
      const { deps, root, plan, stopped } = env
      if (yield* Ref.get(stopped)) return { _tag: "Skipped", reason: "stopped", runs: runs - 1 } as const
      if (yield* deps.overBudget(botId)) {
        return { _tag: "Skipped", reason: "budget: bot", runs: runs - 1 } as const
      }
      const taskId = yield* createStepTask(deps, {
        root,
        plan,
        step,
        botId,
        base,
        prompt,
        budget,
        ...(exclude === undefined ? {} : { exclude }),
      })
      const result = yield* deps
        .runTask(taskId)
        .pipe(Effect.onInterrupt(() => deps.abandon(taskId, PLAN_STOPPED_REASON)))
      if (result.stopped) yield* Ref.set(stopped, true)
      const branch = result.verdict.kind === "ok" ? branchOf(result.verdict) : undefined
      const conflict = conflictOf(result.verdict)
      return {
        _tag: "Ran",
        taskId,
        verdict: result.verdict,
        runs,
        stopped: result.stopped,
        ...(branch === undefined ? {} : { branch }),
        ...(conflict === undefined ? {} : { conflict }),
      } as const
    })
