import { type Artifact, TankError, type TaskSpec } from "@shoalwork/contracts"
import type { GhClientShape } from "@shoalwork/currents"
import { fetchRebase, type GitExec, type TankContext, type TankShape } from "@shoalwork/tank"
import { Effect, Ref } from "effect"
import { type DeliverDeps, makeDeliver } from "./deliver.js"
import {
  commitArgv,
  DeliveryFailed,
  deliveryTitle,
  execStep,
  exitMessage,
  mustSucceed,
} from "./git-delivery.js"
import { CONFLICT_FILE_PREFIX, type Progress, withArtifact, withOutcome } from "./verdict.js"

const GIT_TIMEOUT_MS = 300_000
export const MAX_CONFLICT_FILES = 20
export const MAX_FILE_NAME = 200

// Control characters and the invisible/bidirectional marks that can hide or reorder text.
const unsafeChar = (code: number): boolean =>
  code < 0x20 ||
  (code >= 0x7f && code <= 0x9f) ||
  code === 0x61c ||
  (code >= 0x200b && code <= 0x200f) ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2066 && code <= 0x2069) ||
  code === 0xfeff

// File names come from the repo (R14: data). A name that is empty, long or carries such a character is dropped, and
// at most MAX_CONFLICT_FILES are kept.
export const safeFileNames = (names: ReadonlyArray<string>): ReadonlyArray<string> =>
  names
    .filter(
      (name) =>
        name !== "" &&
        name.length <= MAX_FILE_NAME &&
        !Array.from(name).some((char) => unsafeChar(char.codePointAt(0) ?? 0)),
    )
    .slice(0, MAX_CONFLICT_FILES)

// A task that belongs to a plan step: its branch is integrated by the plan, so it is pushed but never gets a PR.
export const isPlanStep = (spec: Pick<TaskSpec, "parent">): boolean =>
  spec.parent !== undefined && "planId" in spec.parent

// The conflicted files of a failed step delivery: one evidence entry per file (never parsed from the summary).
export const conflictFilesOf = (evidence: ReadonlyArray<string>): ReadonlyArray<string> =>
  safeFileNames(
    evidence
      .filter((line) => line.startsWith(CONFLICT_FILE_PREFIX))
      .map((line) => line.slice(CONFLICT_FILE_PREFIX.length)),
  )

// `lockRepo` runs every command under the lock of the Bot's clone (fetch and rebase race with worktree add/remove).
export const gitExecFor =
  (tank: TankShape, ctx: TankContext): GitExec =>
  (args) =>
    tank
      .exec(ctx, ["git", ...args], { timeoutMs: GIT_TIMEOUT_MS, lockRepo: true })
      .pipe(
        Effect.flatMap((r) =>
          r.timedOut
            ? Effect.fail(new TankError({ op: `git ${args[0] ?? ""}`, cause: "timed out" }))
            : Effect.succeed({ exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }),
        ),
      )

// Commits what the Bot wrote, rebases the branch onto origin/<base> and pushes it. A rebase that conflicts is undone
// and fails the step at "conflict" with the files; the worktree is kept for diagnosis like any failed delivery.
export const deliverBranch = (
  tank: TankShape,
  ctx: TankContext,
  input: { readonly title: string; readonly base: string; readonly issue: number | undefined },
): Effect.Effect<Artifact, DeliveryFailed> =>
  Effect.gen(function* () {
    const branch = ctx.worktree?.branch
    if (branch === undefined) {
      return yield* Effect.fail(new DeliveryFailed({ step: "commit", message: "no worktree to deliver" }))
    }
    yield* mustSucceed(tank, ctx, "commit", ["git", "add", "-A"])
    const staged = yield* execStep(tank, ctx, "commit", ["git", "diff", "--cached", "--quiet"])
    if (staged.exitCode === 0 && !staged.timedOut) {
      return yield* Effect.fail(new DeliveryFailed({ step: "commit", message: "no changes" }))
    }
    if (staged.exitCode !== 1 || staged.timedOut) {
      return yield* Effect.fail(
        new DeliveryFailed({ step: "commit", message: exitMessage(["git", "diff"], staged) }),
      )
    }
    const title = deliveryTitle(input.title, input.issue)
    yield* mustSucceed(tank, ctx, "commit", commitArgv(ctx.botName, title))
    const identity = { name: ctx.botName, email: `${ctx.botName}@bots.shoalwork.invalid` }
    const rebased = yield* fetchRebase(gitExecFor(tank, ctx), input.base, identity).pipe(
      Effect.mapError((error) => new DeliveryFailed({ step: "push", message: String(error.cause) })),
    )
    if (rebased._tag === "Conflict") {
      const files = safeFileNames(rebased.files)
      return yield* Effect.fail(
        new DeliveryFailed({
          step: "conflict",
          message: `rebase conflict in ${rebased.files.length} file(s)`,
          files,
        }),
      )
    }
    yield* mustSucceed(tank, ctx, "push", ["git", "push", "-u", "origin", branch])
    return { kind: "text", ref: branch }
  })

export interface DeliverStepDeps {
  readonly tank: TankShape
  readonly raiseError: (
    spec: Pick<TaskSpec, "id" | "botId">,
    where: string,
    tag: string,
    message: string,
  ) => Effect.Effect<void>
}

// Same contract as deliver.ts for the tasks of a plan: only an ok code run with a repo is delivered, before release.
export const makeDeliverStep =
  ({ tank, raiseError }: DeliverStepDeps) =>
  (spec: TaskSpec, ctx: TankContext, progress: Ref.Ref<Progress>) =>
    Effect.gen(function* () {
      const { outcome } = yield* Ref.get(progress)
      // A review reads the plan branch and answers; it has nothing to deliver.
      if (outcome._tag !== "Done" || spec.kind !== "code" || spec.repo === undefined) return
      if (spec.review !== undefined) return
      yield* deliverBranch(tank, ctx, {
        title: spec.title,
        base: spec.repo.base,
        issue: spec.repo.issue,
      }).pipe(
        Effect.flatMap((artifact) => Ref.update(progress, withArtifact(artifact))),
        Effect.catch((failure) =>
          Effect.gen(function* () {
            yield* raiseError(spec, "lead.delivery", failure._tag, failure.message)
            yield* Ref.update(
              progress,
              withOutcome({
                _tag: "Delivery",
                step: failure.step,
                message: failure.message,
                ...(failure.files === undefined ? {} : { files: failure.files }),
              }),
            )
          }),
        ),
      )
    })

// The delivery of a task after an ok run: plan steps are pushed for the plan to integrate (T-050), any other code
// task opens its own PR.
export const makeDeliverFor = (deps: DeliverDeps & { readonly gh: GhClientShape }) => {
  const pr = makeDeliver(deps)
  const step = makeDeliverStep(deps)
  return (spec: TaskSpec, ctx: TankContext, progress: Ref.Ref<Progress>) =>
    isPlanStep(spec) ? step(spec, ctx, progress) : pr(spec, ctx, progress)
}
