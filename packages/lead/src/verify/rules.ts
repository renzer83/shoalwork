// What the verifier knows about one step's result, and the tie-break that turns it into one final answer.
import type { TestsOutcome } from "@shoalwork/reflex"

export type ArtifactsOutcome = "pass" | "fail"
export type FinalOutcome = "ok" | "failed" | "needs_human"

export interface JudgeAnswer {
  readonly value: boolean
  readonly confidence: number
}

export interface Verification {
  readonly tests: TestsOutcome
  readonly artifacts: ArtifactsOutcome
  readonly judge: JudgeAnswer
  readonly final: FinalOutcome
  // Why a check failed, in our own sentences (a refused command, an unconfined file, a spent budget).
  readonly notes: ReadonlyArray<string>
}

// A judge answer below this confidence never decides alone: a person does.
export const JUDGE_MIN_CONFIDENCE = 0.6

// Fail-closed: only a confidence that is a number in [JUDGE_MIN_CONFIDENCE, 1] lets the judge decide.
// NaN, Infinity, values above 1 and negatives all count as "not confident".
const judgeDecides = (confidence: number): boolean => confidence >= JUDGE_MIN_CONFIDENCE && confidence <= 1

// Tie-break, in order: the tests decide when they exist; a failed artifact fails the step; with no tests the judge
// decides when it is confident; otherwise the answer goes to a person.
export const decide = (
  tests: TestsOutcome,
  artifacts: ArtifactsOutcome,
  judge: JudgeAnswer,
): FinalOutcome => {
  if (tests === "fail" || artifacts === "fail") {
    return "failed"
  }
  if (tests === "pass") {
    return "ok"
  }
  if (!judgeDecides(judge.confidence)) {
    return "needs_human"
  }
  return judge.value ? "ok" : "failed"
}
