import type { TaskSpec } from "@shoalwork/contracts"
import type { GhClientShape } from "@shoalwork/currents"
import type { TankContext, TankShape } from "@shoalwork/tank"
import { Effect, Ref } from "effect"
import { deliverCode } from "./git-delivery.js"
import { type Progress, withArtifact, withOutcome } from "./verdict.js"

export interface DeliverDeps {
  readonly tank: TankShape
  readonly gh: GhClientShape
  readonly raiseError: (
    spec: Pick<TaskSpec, "id" | "botId">,
    where: string,
    tag: string,
    message: string,
  ) => Effect.Effect<void>
}

// Only an ok run of a code task with a repo is delivered, inside the worktree the Bot wrote to (before release).
// A failed delivery turns the outcome into a Delivery failure, so the verdict is not ok and the worktree is kept.
export const makeDeliver =
  ({ tank, gh, raiseError }: DeliverDeps) =>
  (spec: TaskSpec, ctx: TankContext, progress: Ref.Ref<Progress>) =>
    Effect.gen(function* () {
      const { outcome } = yield* Ref.get(progress)
      if (outcome._tag !== "Done" || spec.kind !== "code" || spec.repo === undefined) return
      yield* deliverCode(
        tank,
        ctx,
        {
          taskId: spec.id,
          title: spec.title,
          base: spec.repo.base,
          issue: spec.repo.issue,
        },
        gh,
      ).pipe(
        Effect.flatMap((artifact) => Ref.update(progress, withArtifact(artifact))),
        Effect.catch((failure) =>
          Effect.gen(function* () {
            yield* raiseError(spec, "lead.delivery", failure._tag, failure.message)
            yield* Ref.update(
              progress,
              withOutcome({ _tag: "Delivery", step: failure.step, message: failure.message }),
            )
          }),
        ),
      )
    })
