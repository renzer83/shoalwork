import type { Verdict } from "@shoalwork/contracts"
import type { PlanRun } from "./plan/dispatcher.js"
import { clip, EVIDENCE_MAX, SUMMARY_MAX } from "./verdict.js"

export type Cost = Verdict["cost"]

export const sumCost = (costs: ReadonlyArray<Cost>): Cost =>
  costs.reduce(
    (total, cost) => ({
      tokensIn: total.tokensIn + cost.tokensIn,
      tokensOut: total.tokensOut + cost.tokensOut,
      usd: total.usd + cost.usd,
      seconds: total.seconds + cost.seconds,
    }),
    { tokensIn: 0, tokensOut: 0, usd: 0, seconds: 0 },
  )

// The verdict of the root task: what the plan came to. A done plan is ok with its PR (or branch) as evidence; a
// failed one lists the steps that did not finish, with their reasons.
export const planVerdict = (run: PlanRun, titles: ReadonlyMap<string, string>, cost: Cost): Verdict => {
  if (run.state === "done") {
    const where = run.pr?.ref ?? run.branch
    return {
      kind: "ok",
      summary: `plan done: ${run.steps.length} step(s)`,
      evidence: where === undefined ? [] : [clip(where, EVIDENCE_MAX)],
      cost,
    }
  }
  const unfinished = run.steps.filter((step) => step.status !== "done")
  const lines = unfinished.map(
    (step) => `${titles.get(step.stepId) ?? step.stepId} (${step.status}): ${step.reason ?? "no reason"}`,
  )
  const summary = run.reason ?? `plan failed: ${unfinished.length} of ${run.steps.length} step(s) not done`
  return {
    kind: "failed",
    summary: clip(summary, SUMMARY_MAX),
    evidence: lines.map((line) => clip(line, EVIDENCE_MAX)).slice(0, 10),
    cost,
  }
}
