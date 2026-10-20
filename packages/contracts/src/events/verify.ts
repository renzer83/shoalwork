import { Schema } from "effect"
import { PlanId, StepId, TaskId } from "../ids.js"

const Note = Schema.String.check(Schema.isMaxLength(300))

// The Lead's verdict on a work step that ran its checks (verifier tie-break). Notes are sentences of the Lead's own.
export const StepVerifiedPayload = Schema.Struct({
  taskId: TaskId,
  planId: PlanId,
  stepId: StepId,
  tests: Schema.Literals(["pass", "fail", "none"]),
  artifacts: Schema.Literals(["pass", "fail"]),
  final: Schema.Literals(["ok", "failed", "needs_human"]),
  notes: Schema.Array(Note),
})

// What the Lead decided about one review round. `findings` counts BLOCKER and MAJOR items; the text is not kept.
export const ReviewDecidedPayload = Schema.Struct({
  taskId: TaskId,
  planId: PlanId,
  stepId: StepId,
  round: Schema.Int,
  decision: Schema.Literals(["accept", "fix", "blocked", "needs_human"]),
  findings: Schema.Int,
  reason: Schema.optional(Note),
})
