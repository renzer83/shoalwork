import type { BeaconShape } from "@shoalwork/beacon"
import type { Budget, PlanId, TaskSpec } from "@shoalwork/contracts"
import { Effect } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import { recordVerified } from "./step-events.js"
import { type Attempt, failRan, type Job } from "./step-outcome.js"
import { budgetLeft, verifyRetryPrompt } from "./step-task.js"
import type { VerifyStep } from "./step-verify.js"

export interface GateEnv {
  readonly root: TaskSpec
  readonly beacon: BeaconShape
  readonly planId: PlanId
  readonly verify: VerifyStep
  readonly baseNow: Effect.Effect<string>
  readonly run: (
    job: Job,
    base: string,
    prompt: string,
    runs: number,
    budget: Budget,
  ) => Effect.Effect<Attempt, SqlError>
}

// A work step that has checks and finished ok is verified before it is merged; a step without checks is not (the judge
// never blocks for lack of data). "failed" earns the step's one retry (told what failed, from the branch it pushed and
// the budget it has left); "needs_human" (a refused check included) blocks it and spends no retry; a step with no run
// left fails.
export const makeGate = (env: GateEnv) => {
  const gate = (job: Job, attempt: Attempt, canRetry: boolean): Effect.Effect<Attempt, SqlError> =>
    Effect.gen(function* () {
      if (attempt._tag !== "Ran" || attempt.verdict.kind !== "ok" || attempt.stopped) return attempt
      if (job.step.checks.length === 0) return attempt
      const base = attempt.branch ?? (yield* env.baseNow)
      const verification = yield* env.verify({
        root: env.root,
        step: job.step,
        botId: job.botId,
        taskId: attempt.taskId,
        base,
        verdict: attempt.verdict,
      })
      yield* recordVerified(
        { beacon: env.beacon, planId: env.planId, stepId: job.step.id, taskId: attempt.taskId },
        verification,
      )
      if (verification.final === "ok") return attempt
      const why = [`tests ${verification.tests}, artifacts ${verification.artifacts}`, ...verification.notes]
      if (verification.final === "needs_human") {
        return {
          _tag: "Skipped",
          reason: `needs_human: ${why.join("; ")}`,
          runs: attempt.runs,
          taskId: attempt.taskId,
        } as const
      }
      const reason = `verification failed: ${why.join("; ")}`
      const left =
        canRetry && attempt.runs < 2 ? budgetLeft(job.step.budget, attempt.verdict.cost) : undefined
      if (left === undefined) return failRan(attempt, reason)
      const again = yield* env.run(
        job,
        attempt.branch ?? (yield* env.baseNow),
        verifyRetryPrompt(job.step, why),
        2,
        left,
      )
      return yield* gate(job, again, false)
    })
  return gate
}
