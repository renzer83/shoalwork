import type { BeaconShape } from "@shoalwork/beacon"
import {
  type Artifact,
  type BotId,
  type NotFound,
  type Plan,
  type PlanId,
  SchemaViolation,
  type StepId,
  type TaskId,
  type TaskSpec,
  topoOrder,
  validatePlan,
} from "@shoalwork/contracts"
import { Effect, Ref, type Scope } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import type { TaskStoreShape } from "../tasks.js"
import type { IntegrationFailed, IntegrationSession } from "./integration.js"
import { makeReviewFlow } from "./review-flow.js"
import { makeRunOnce, type StepResult } from "./run-once.js"
import {
  type Attempt,
  blockedWith,
  conflictReason,
  failedWith,
  type Job,
  outcomeOf,
  type StepOutcome,
} from "./step-outcome.js"
import { budgetLeft, retryPrompt } from "./step-task.js"
import type { VerifyStep } from "./step-verify.js"
import { makeGate } from "./verify-gate.js"

export const DEFAULT_PLAN_CONCURRENCY = 3

export { PLAN_STOPPED_REASON, type StepResult } from "./run-once.js"

export interface DispatcherDeps {
  readonly sql: SqlClient
  readonly beacon: BeaconShape
  readonly tasks: TaskStoreShape
  readonly runTask: (id: TaskId) => Effect.Effect<StepResult>
  // Closes a task that will not get a verdict (Lead.abandon): the steps an interruption leaves unfinished.
  readonly abandon: (id: TaskId, reason: string) => Effect.Effect<void>
  // Whether the Bot already spent its budget window (budget.botOverBudget); checked before every task is created.
  readonly overBudget: (botId: BotId) => Effect.Effect<boolean, SqlError>
  readonly integration: {
    readonly open: (root: TaskSpec) => Effect.Effect<IntegrationSession, IntegrationFailed, Scope.Scope>
  }
  // Verification of a work step that finished ok (makeStepVerify): its checks and the tie-break of the verifier.
  readonly verify: VerifyStep
  // config PLAN_CONCURRENCY: how many steps of one level run at once.
  readonly concurrency: number
}

export type { StepOutcome, StepStatus } from "./step-outcome.js"

export interface PlanRun {
  readonly planId: PlanId
  readonly state: "done" | "failed"
  readonly steps: ReadonlyArray<StepOutcome>
  readonly branch?: string
  // The single PR of the plan branch, opened only when every step is done and something was merged.
  readonly pr?: Artifact
  // Why a plan whose steps are all done still failed (the PR could not be opened).
  readonly reason?: string
}

export type DispatchError = NotFound | SqlError | SchemaViolation | IntegrationFailed

export const makeDispatcher = (deps: DispatcherDeps) => {
  const concurrency = Math.max(1, deps.concurrency)

  const run = (plan: Plan, assignments: ReadonlyMap<StepId, BotId>): Effect.Effect<PlanRun, DispatchError> =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* validatePlan(plan)
        const root = (yield* deps.tasks.get(plan.taskId)).spec
        const jobs = new Map<StepId, Job>()
        for (const step of plan.steps) {
          const botId = assignments.get(step.id)
          if (botId === undefined) {
            return yield* Effect.fail(
              new SchemaViolation({ where: "Dispatcher.assignments", issue: `step ${step.id} has no Bot` }),
            )
          }
          jobs.set(step.id, { step, botId })
        }
        // validatePlan and the check above make every lookup total; a miss is a bug.
        const jobOf = (id: StepId) => {
          const job = jobs.get(id)
          return job === undefined ? Effect.die(`unknown step ${id}`) : Effect.succeed(job)
        }
        const outcomes = new Map<StepId, StepOutcome>()
        const outcomeFor = (id: StepId): StepOutcome =>
          outcomes.get(id) ?? { stepId: id, status: "failed", runs: 0, reason: "not run" }
        const integrating = root.repo !== undefined && root.kind === "code"
        const session = integrating ? yield* deps.integration.open(root) : undefined
        // Set once a run comes back stopped: from then on no task is created and the rest of the plan is blocked.
        const stopped = yield* Ref.make(false)
        const baseNow = Effect.gen(function* () {
          const published = session !== undefined && (yield* session.isPublished)
          return published ? session.branch : (root.repo?.base ?? "")
        })

        const runBare = makeRunOnce({ deps, root, plan, stopped })
        // Every task a work step (or the fix of a review) ran as, discarded attempts included: the reviewer's
        // executor must differ from all of theirs.
        const workTasks: Array<TaskId> = []
        const runOnce: typeof runBare = (job, ...rest) =>
          runBare(job, ...rest).pipe(
            Effect.tap((attempt) =>
              job.step.kind === "work" && attempt._tag === "Ran"
                ? Effect.sync(() => void workTasks.push(attempt.taskId))
                : Effect.void,
            ),
          )

        // The one retry a conflict earns: the rest of the step's budget, from `base`, told which files clash.
        const retry = (
          job: Job,
          first: Extract<Attempt, { _tag: "Ran" }>,
          base: string,
          files: ReadonlyArray<string>,
        ): Effect.Effect<Attempt, SqlError> => {
          const left = budgetLeft(job.step.budget, first.verdict.cost)
          return left === undefined
            ? Effect.succeed({
                _tag: "Skipped",
                reason: `${conflictReason(files)}; step budget spent`,
                runs: 1,
                taskId: first.taskId,
              } as const)
            : runOnce(job, base, retryPrompt(job.step, base, files), 2, left)
        }

        const gate = makeGate({
          root,
          beacon: deps.beacon,
          planId: plan.id,
          verify: deps.verify,
          baseNow,
          run: runOnce,
        })

        // A work step is run; a conflict at delivery earns the retry, from the plan branch when it is published.
        // What comes out is verified before it is merged.
        const runWork = (job: Job): Effect.Effect<Attempt, SqlError> =>
          Effect.gen(function* () {
            const first = yield* runOnce(job, yield* baseNow, job.step.prompt, 1, job.step.budget)
            if (first._tag === "Skipped" || first.conflict === undefined) return yield* gate(job, first, true)
            return yield* gate(job, yield* retry(job, first, yield* baseNow, first.conflict), true)
          })

        // Merges a finished step; a merge conflict earns the one retry (if the step has not used it) and a second
        // merge. A failure of the integration itself fails that step only.
        const integrate = (id: StepId, job: Job, attempt: Attempt): Effect.Effect<StepOutcome, SqlError> =>
          Effect.gen(function* () {
            if (
              session === undefined ||
              attempt._tag !== "Ran" ||
              attempt.verdict.kind !== "ok" ||
              attempt.stopped ||
              job.step.kind === "review"
            ) {
              return outcomeOf(id, attempt)
            }
            if (attempt.branch === undefined) {
              return failedWith(id, attempt, "step finished ok but pushed no branch to integrate")
            }
            const merged = (branch: string) => session.merge({ stepId: id, title: job.step.title, branch })
            const first = yield* merged(attempt.branch)
            if (first._tag === "Merged") return outcomeOf(id, attempt)
            if (attempt.runs > 1) return blockedWith(outcomeOf(id, attempt), conflictReason(first.files))
            yield* session.publish
            const again = yield* gate(job, yield* retry(job, attempt, session.branch, first.files), false)
            if (again._tag !== "Ran" || again.verdict.kind !== "ok" || again.stopped)
              return outcomeOf(id, again)
            if (again.branch === undefined) {
              return failedWith(id, again, "step finished ok but pushed no branch to integrate")
            }
            const second = yield* merged(again.branch)
            return second._tag === "Merged"
              ? outcomeOf(id, again)
              : blockedWith(outcomeOf(id, again), conflictReason(second.files))
          }).pipe(
            Effect.catchTag("IntegrationFailed", (error) =>
              Effect.succeed(failedWith(id, attempt, `integration ${error.op}: ${error.cause}`)),
            ),
          )

        // The fix a review asks for lands like any step: merged into the plan branch, which is then published.
        const land = (job: Job, attempt: Attempt): Effect.Effect<StepOutcome, SqlError> =>
          Effect.gen(function* () {
            const outcome = yield* integrate(job.step.id, job, attempt)
            if (outcome.status !== "done" || session === undefined) return outcome
            const pushed = yield* Effect.result(session.publish)
            return pushed._tag === "Success"
              ? outcome
              : failedWith(job.step.id, attempt, `integration ${pushed.failure.op}: ${pushed.failure.cause}`)
          })
        const runReview = makeReviewFlow({
          root,
          planId: plan.id,
          beacon: deps.beacon,
          baseNow,
          run: runOnce,
          land,
          workTasks: () => workTasks,
        })
        const runStep = (job: Job) => (job.step.kind === "review" ? runReview(job) : runWork(job))

        for (const level of topoOrder(plan)) {
          const ready: Array<Job> = []
          for (const id of level) {
            const job = yield* jobOf(id)
            const broken = job.step.dependsOn.find((dep) => outcomes.get(dep)?.status !== "done")
            if (yield* Ref.get(stopped)) {
              outcomes.set(id, { stepId: id, status: "blocked", runs: 0, reason: "stopped" })
            } else if (broken !== undefined) {
              outcomes.set(id, { stepId: id, status: "blocked", runs: 0, reason: `depends on ${broken}` })
            } else {
              ready.push(job)
            }
          }
          const finished = yield* Effect.forEach(
            ready,
            (job) => runStep(job).pipe(Effect.map((attempt) => [job, attempt] as const)),
            { concurrency },
          )
          // Plan order, one at a time: the merges of a plan are serialized.
          for (const [job, attempt] of finished) {
            outcomes.set(job.step.id, yield* integrate(job.step.id, job, attempt))
          }
          const merged = ready.filter((job) => outcomes.get(job.step.id)?.status === "done")
          if (session !== undefined && merged.length > 0) {
            const pushed = yield* Effect.result(session.publish)
            if (pushed._tag === "Failure") {
              // Dependents would start from a plan branch that is not on origin: the merged steps fail instead.
              for (const job of merged) {
                outcomes.set(job.step.id, {
                  ...outcomeFor(job.step.id),
                  status: "failed",
                  reason: `integration ${pushed.failure.op}: ${pushed.failure.cause}`,
                })
              }
            }
          }
        }

        const all = plan.steps.map((step) => outcomeFor(step.id))
        const done = all.every((outcome) => outcome.status === "done")
        const pr =
          done && session !== undefined && (yield* session.isPublished)
            ? yield* Effect.result(session.openPr)
            : undefined
        const opened = pr !== undefined && pr._tag === "Success" ? pr.success : undefined
        const prFailure = pr !== undefined && pr._tag === "Failure" ? pr.failure : undefined
        return {
          planId: plan.id,
          state: done && prFailure === undefined ? "done" : "failed",
          steps: all,
          ...(session === undefined ? {} : { branch: session.branch }),
          ...(opened === undefined ? {} : { pr: opened }),
          ...(prFailure === undefined ? {} : { reason: `integration ${prFailure.op}: ${prFailure.cause}` }),
        } satisfies PlanRun
      }),
    )

  return { run }
}

export type Dispatcher = ReturnType<typeof makeDispatcher>
