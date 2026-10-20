import type { BeaconShape } from "@shoalwork/beacon"
import type { Budget, ExecutorId, PlanId, TaskId, TaskSpec } from "@shoalwork/contracts"
import { Effect } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import { sumCost } from "../plan-verdict.js"
import { SUMMARY_MAX } from "../verdict.js"
import { decideReview, type Finding, fixPrompt, parseReview } from "../verify/review.js"
import { executorsUsed, fullResult } from "./executors-used.js"
import { recordReview } from "./step-events.js"
import { type Attempt, failRan, isNoExecutor, type Job, type Ran, type StepOutcome } from "./step-outcome.js"
import { budgetLeft } from "./step-task.js"

export const NO_REVIEWER = "needs_human: no executor other than the worker's is available to review"
const NO_WORKER_RECORD =
  "needs_human: no executor was recorded for the work steps, so the reviewer cannot be kept apart from them"
const CUT_SHORT = "needs_human: the review answer was cut short and its full text is not available"
const FIX_TITLE = "Fix review findings"

export interface ReviewEnv {
  readonly root: TaskSpec
  readonly planId: PlanId
  readonly beacon: BeaconShape
  // The plan branch once something was merged into it, else the repo's base.
  readonly baseNow: Effect.Effect<string>
  // One run of a step as its own task (the dispatcher's runOnce); `exclude` marks the task as a review.
  readonly run: (
    job: Job,
    base: string,
    prompt: string,
    runs: number,
    budget: Budget,
    exclude?: ReadonlyArray<ExecutorId>,
  ) => Effect.Effect<Attempt, SqlError>
  // Merges the fix into the plan branch and publishes it; what became of the fix step.
  readonly land: (job: Job, attempt: Attempt) => Effect.Effect<StepOutcome, SqlError>
  // Every task any work step (and the fix) ran as, discarded attempts included: the reviewer differs from all of them.
  readonly workTasks: () => ReadonlyArray<TaskId>
}

type Next =
  | { readonly _tag: "done"; readonly attempt: Attempt }
  | { readonly _tag: "fix"; readonly attempt: Ran; readonly findings: ReadonlyArray<Finding> }

const skipped = (reason: string, runs: number, attempt: Attempt): Attempt => ({
  _tag: "Skipped",
  reason,
  runs,
  ...(attempt.taskId === undefined ? {} : { taskId: attempt.taskId }),
})

// The review step of a plan: the reviewer reads the plan branch on an executor other than every worker's. BLOCKER or
// MAJOR earns one fix (by the plan's owner, merged into the plan branch) and one more review, kept apart from the fix's
// executor too; findings that persist fail the step, so the plan opens no PR. The whole thing spends the one budget the
// review step reserved. Every round leaves a review.decided event on the review task.
export const makeReviewFlow = (env: ReviewEnv) => (job: Job) =>
  Effect.gen(function* () {
    let spent = sumCost([])
    const where = (taskId: TaskId) => ({
      beacon: env.beacon,
      planId: env.planId,
      stepId: job.step.id,
      taskId,
    })

    // What a review run means: its whole answer (the summary is cut), parsed, then the decision for this round.
    const decide = (attempt: Attempt, round: number): Effect.Effect<Next, SqlError> =>
      Effect.gen(function* () {
        if (attempt._tag !== "Ran" || attempt.stopped) return { _tag: "done", attempt } as const
        if (attempt.verdict.kind !== "ok") {
          const blocked = isNoExecutor(attempt.verdict)
          if (blocked)
            yield* recordReview(where(attempt.taskId), {
              round,
              decision: "needs_human",
              findings: 0,
              reason: NO_REVIEWER,
            })
          return { _tag: "done", attempt: blocked ? skipped(NO_REVIEWER, round, attempt) : attempt } as const
        }
        const cut = attempt.verdict.summary.length >= SUMMARY_MAX
        const text = cut ? yield* fullResult(env.beacon, attempt.taskId) : attempt.verdict.summary
        const decision =
          text === undefined
            ? ({ _tag: "needs_human", reason: CUT_SHORT } as const)
            : decideReview(parseReview(text), round)
        const findings = decision._tag === "fix" ? decision.findings.length : 0
        yield* recordReview(where(attempt.taskId), {
          round,
          decision: decision._tag,
          findings,
          ...("reason" in decision ? { reason: decision.reason } : {}),
        })
        switch (decision._tag) {
          case "accept":
            return { _tag: "done", attempt } as const
          case "needs_human":
            return {
              _tag: "done",
              attempt: skipped(`needs_human: ${decision.reason}`, round, attempt),
            } as const
          case "blocked":
            return { _tag: "done", attempt: failRan(attempt, decision.reason) } as const
          case "fix":
            return { _tag: "fix", attempt, findings: decision.findings } as const
        }
      })

    const review = (round: number): Effect.Effect<Attempt, SqlError> =>
      Effect.gen(function* () {
        const budget = round === 1 ? job.step.budget : budgetLeft(job.step.budget, spent)
        if (budget === undefined) {
          return {
            _tag: "Skipped",
            reason: "needs_human: the review budget is spent",
            runs: round - 1,
          } as const
        }
        const exclude = yield* executorsUsed(env.beacon, env.workTasks())
        if (exclude.length === 0)
          return { _tag: "Skipped", reason: NO_WORKER_RECORD, runs: round - 1 } as const
        const attempt = yield* env.run(job, yield* env.baseNow, job.step.prompt, round, budget, exclude)
        if (attempt._tag === "Ran") spent = sumCost([spent, attempt.verdict.cost])
        return attempt
      })

    const first = yield* decide(yield* review(1), 1)
    if (first._tag === "done") return first.attempt

    const left = budgetLeft(job.step.budget, spent)
    if (left === undefined)
      return failRan(first.attempt, "the review found blocking issues and its budget is spent")
    const fixJob: Job = {
      botId: env.root.botId,
      step: {
        ...job.step,
        kind: "work",
        title: FIX_TITLE,
        prompt: fixPrompt(env.root.prompt, first.findings),
        acceptance: [],
        checks: [],
      },
    }
    const fix = yield* env.run(fixJob, yield* env.baseNow, fixJob.step.prompt, 2, left)
    if (fix._tag !== "Ran" || fix.verdict.kind !== "ok" || fix.stopped) return fix
    spent = sumCost([spent, fix.verdict.cost])
    const landed = yield* env.land(fixJob, fix)
    if (landed.status === "failed") return failRan(fix, landed.reason ?? "the fix could not be merged")
    if (landed.status === "blocked") return skipped(landed.reason ?? "the fix could not be merged", 2, fix)

    // The fix's own task is among workTasks (the dispatcher tracks every work run), so its executor is excluded now.
    const after = yield* decide(yield* review(2), 2)
    return after._tag === "done"
      ? after.attempt
      : failRan(after.attempt, "the review still has blocking findings")
  })
