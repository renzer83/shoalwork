import type { BeaconShape } from "@shoalwork/beacon"
import { type PlanId, type StepId, streamIds, type TaskId } from "@shoalwork/contracts"
import type { Effect } from "effect"
import { emit } from "../tasks.js"
import { clip } from "../verdict.js"
import type { Verification } from "../verify/rules.js"

const NOTE_MAX = 300
const ACTOR = "system:lead"

interface Where {
  readonly beacon: BeaconShape
  readonly planId: PlanId
  readonly stepId: StepId
  readonly taskId: TaskId
}

// R12: what the verifier concluded about a step run, on that run's task stream.
export const recordVerified = (where: Where, verification: Verification): Effect.Effect<void> =>
  emit(where.beacon, {
    streamId: streamIds.task(where.taskId),
    type: "step.verified",
    payload: {
      taskId: where.taskId,
      planId: where.planId,
      stepId: where.stepId,
      tests: verification.tests,
      artifacts: verification.artifacts,
      final: verification.final,
      notes: verification.notes.map((note) => clip(note, NOTE_MAX)),
    },
    actor: ACTOR,
    correlationId: where.taskId,
  })

// R12: what the Lead decided about a review round, on the review task's stream.
export const recordReview = (
  where: Where,
  decision: {
    readonly round: number
    readonly decision: "accept" | "fix" | "blocked" | "needs_human"
    readonly findings: number
    readonly reason?: string
  },
): Effect.Effect<void> =>
  emit(where.beacon, {
    streamId: streamIds.task(where.taskId),
    type: "review.decided",
    payload: {
      taskId: where.taskId,
      planId: where.planId,
      stepId: where.stepId,
      round: decision.round,
      decision: decision.decision,
      findings: decision.findings,
      ...(decision.reason === undefined ? {} : { reason: clip(decision.reason, NOTE_MAX) }),
    },
    actor: ACTOR,
    correlationId: where.taskId,
  })
