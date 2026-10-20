import type { BotRegistryShape } from "@shoalwork/bots"
import type { Artifact, StepId, TaskId, TaskSpec } from "@shoalwork/contracts"
import type { GhClientShape } from "@shoalwork/currents"
import { changedFiles, mergeNoFf, type TankContext, type TankShape } from "@shoalwork/tank"
import { Data, Effect, Ref, type Scope, Semaphore } from "effect"
import { cleanText, deliveryBody, deliveryTitle, mustSucceed } from "../git-delivery.js"
import { gitExecFor } from "../step-delivery.js"
import { describeFailure, stepIdFor } from "../verdict.js"

export class IntegrationFailed extends Data.TaggedError("IntegrationFailed")<{
  readonly op: string
  readonly cause: string
}> {}

// `plan/<first 6 chars of the task id>`: the one branch every step of the plan is merged into.
export const planBranchOf = (taskId: TaskId): string =>
  `plan/${taskId.slice("task_".length, "task_".length + 6)}`

// The integration worktree has its own step id (attempt -1 never happens for a task), so it never meets a task run.
const integrationStepId = (taskId: TaskId): StepId => stepIdFor(taskId, -1)

export interface StepBranch {
  readonly stepId: StepId
  readonly title: string
  // The branch the step pushed to origin.
  readonly branch: string
}

export type MergeOutcome =
  // `serialized`: the step touched files an earlier merge of this plan already changed (`overlap`), so it was
  // merged strictly after that one; every merge of a plan is serialized in any case.
  | { readonly _tag: "Merged"; readonly serialized: boolean; readonly overlap: ReadonlyArray<string> }
  | { readonly _tag: "Conflict"; readonly files: ReadonlyArray<string> }

export interface IntegrationSession {
  readonly branch: string
  readonly merge: (step: StepBranch) => Effect.Effect<MergeOutcome, IntegrationFailed>
  // Pushes the plan branch, so that the steps that depend on merged work can start from it.
  readonly publish: Effect.Effect<void, IntegrationFailed>
  readonly isPublished: Effect.Effect<boolean>
  // One PR for the whole plan branch, against the repo's base.
  readonly openPr: Effect.Effect<Artifact, IntegrationFailed>
}

export interface IntegrationDeps {
  readonly tank: TankShape
  readonly gh: GhClientShape
  readonly bots: BotRegistryShape
}

const failed = (op: string, cause: unknown) =>
  new IntegrationFailed({ op, cause: describeFailure(cause).message })

// The plan branch lives in a worktree of the task owner's clone (its Tank): merges and pushes run there, and the
// worktree goes away with the scope. Steps of other Bots reach it through origin.
export const makeIntegration = (deps: IntegrationDeps) => ({
  open: (root: TaskSpec): Effect.Effect<IntegrationSession, IntegrationFailed, Scope.Scope> =>
    Effect.gen(function* () {
      const repo = root.repo
      if (repo === undefined)
        return yield* Effect.fail(new IntegrationFailed({ op: "open", cause: "no repo" }))
      const bot = yield* deps.bots.get(root.botId).pipe(Effect.mapError((e) => failed("open", e)))
      const branch = planBranchOf(root.id)
      // The local plan branch is a scratch copy: it goes away with the worktree (the branch on origin is the record).
      const ctx: TankContext = yield* Effect.acquireRelease(
        deps.tank
          .prepare(bot, { stepId: integrationStepId(root.id), repo })
          .pipe(Effect.mapError((e) => failed("prepare", e))),
        (made) => {
          const inside = gitExecFor(deps.tank, made)
          return inside(["switch", "--detach"]).pipe(
            Effect.andThen(inside(["branch", "-D", branch])),
            Effect.ignore,
            Effect.andThen(deps.tank.release(made, { keepWorktree: false }).pipe(Effect.ignore)),
          )
        },
      )
      const exec = gitExecFor(deps.tank, ctx)
      const guard = <A>(op: string, effect: Effect.Effect<A, unknown>) =>
        effect.pipe(Effect.mapError((e) => failed(op, e)))
      const must = (op: string, args: ReadonlyArray<string>) =>
        guard(
          op,
          exec(args).pipe(
            Effect.flatMap((r) =>
              r.exitCode === 0
                ? Effect.succeed(r)
                : Effect.fail(new Error(r.stderr.trim() || `exit ${r.exitCode}`)),
            ),
          ),
        )
      // A plan branch a previous run of this task already pushed is continued; a local leftover is reset.
      const onOrigin = yield* guard(
        "switch",
        exec(["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`]).pipe(
          Effect.map((r) => r.exitCode === 0),
        ),
      )
      yield* must(
        "switch",
        onOrigin ? ["switch", "-C", branch, `origin/${branch}`] : ["switch", "-C", branch],
      )
      const lock = yield* Semaphore.make(1)
      const touched = new Set<string>()
      const published = yield* Ref.make(onOrigin)
      const identity = { name: bot.name, email: `${bot.name}@bots.shoalwork.invalid` }

      const merge = (step: StepBranch): Effect.Effect<MergeOutcome, IntegrationFailed> =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            yield* must("fetch", ["fetch", "origin"])
            const files = yield* guard("diff", changedFiles(exec, repo.base, `origin/${step.branch}`))
            const overlap = files.filter((file) => touched.has(file))
            const message = cleanText(`Merge ${step.title}`, `Merge ${step.stepId}`)
            const result = yield* guard("merge", mergeNoFf(exec, `origin/${step.branch}`, message, identity))
            if (result._tag === "Conflict") return { _tag: "Conflict", files: result.files } as const
            for (const file of files) touched.add(file)
            return { _tag: "Merged", serialized: overlap.length > 0, overlap } as const
          }),
        )

      const publish = guard(
        "push",
        mustSucceed(deps.tank, ctx, "push", ["git", "push", "-u", "origin", branch]).pipe(
          Effect.andThen(Ref.set(published, true)),
        ),
      )
      const openPr = guard(
        "pr",
        deps.gh.prCreate(ctx, {
          title: deliveryTitle(root.title, repo.issue),
          body: deliveryBody(root.id, repo.issue),
          base: repo.base,
        }),
      ).pipe(Effect.map((pr): Artifact => ({ kind: "pr", ref: pr.url })))
      return { branch, merge, publish, isPublished: Ref.get(published), openPr }
    }),
})

export type Integration = ReturnType<typeof makeIntegration>
