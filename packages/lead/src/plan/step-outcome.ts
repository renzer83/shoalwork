import type { BotId, Step, StepId, TaskId, Verdict } from "@shoalwork/contracts"
import { conflictFilesOf } from "../step-delivery.js"
import { clip, SUMMARY_MAX } from "../verdict.js"

export interface Job {
  readonly step: Step
  readonly botId: BotId
}

export type StepStatus = "done" | "failed" | "blocked"

export interface StepOutcome {
  readonly stepId: StepId
  readonly status: StepStatus
  readonly taskId?: TaskId
  readonly reason?: string
  // Runs of the step: 2 when a conflict gave it its one retry.
  readonly runs: number
}

export type Attempt =
  | {
      readonly _tag: "Ran"
      readonly taskId: TaskId
      readonly verdict: Verdict
      readonly runs: number
      readonly stopped: boolean
      readonly branch?: string
      // Set when the run ended in a rebase conflict at delivery.
      readonly conflict?: ReadonlyArray<string>
    }
  | { readonly _tag: "Skipped"; readonly reason: string; readonly runs: number; readonly taskId?: TaskId }

export type Ran = Extract<Attempt, { readonly _tag: "Ran" }>

// A run that finished ok but did not pass verification or review: the step failed, its task keeps what it recorded.
export const failRan = (attempt: Ran, reason: string): Attempt => ({
  ...attempt,
  verdict: { ...attempt.verdict, kind: "failed", summary: clip(reason, SUMMARY_MAX) },
})

// The run did not start because no executor outside the worker's was available (runner: NoExecutor).
export const isNoExecutor = (verdict: Verdict): boolean =>
  verdict.kind === "blocked" &&
  verdict.evidence.some((line) => line.startsWith("no executor available for tier"))

export const conflictOf = (verdict: Verdict): ReadonlyArray<string> | undefined =>
  verdict.kind === "failed" && verdict.evidence.includes("delivery: conflict")
    ? conflictFilesOf(verdict.evidence)
    : undefined

export const conflictReason = (files: ReadonlyArray<string>): string => `conflict: ${files.join(", ")}`

// What a finished attempt means for its step (before any merge).
export const outcomeOf = (id: StepId, attempt: Attempt): StepOutcome => {
  if (attempt._tag === "Skipped") {
    return {
      stepId: id,
      status: "blocked",
      runs: attempt.runs,
      reason: attempt.reason,
      ...(attempt.taskId === undefined ? {} : { taskId: attempt.taskId }),
    }
  }
  const base = { stepId: id, taskId: attempt.taskId, runs: attempt.runs }
  if (attempt.stopped) return { ...base, status: "blocked", reason: "stopped" }
  if (attempt.verdict.kind === "ok") return { ...base, status: "done" }
  if (attempt.conflict !== undefined) {
    return { ...base, status: "blocked", reason: conflictReason(attempt.conflict) }
  }
  return { ...base, status: "failed", reason: attempt.verdict.summary }
}

export const blockedWith = (outcome: StepOutcome, reason: string): StepOutcome => ({
  ...outcome,
  status: "blocked",
  reason,
})

export const failedWith = (id: StepId, attempt: Attempt, reason: string): StepOutcome => ({
  stepId: id,
  status: "failed",
  runs: attempt.runs,
  reason,
  ...(attempt.taskId === undefined ? {} : { taskId: attempt.taskId }),
})
