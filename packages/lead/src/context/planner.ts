import type { ModelTier, TaskSpec } from "@shoalwork/contracts"
import type { StandardDecision } from "@shoalwork/reflex"
import type { ContextConfig } from "./config.js"

// How much context a run gets: nothing, the three best items of each source, or everything the level allows.
export type ContextLevel = "none" | "top3" | "full"

// Only the part of the Reflex decision the gate reads, so a caller without a full decision can still ask.
export type PlanningDecision = Pick<StandardDecision, "complexity">

// chat/system -> none. code|research with a repo -> top3 when complexity <= 1, else full; without a
// repo there is no code to look at, so top3. app_op and routine -> top3.
export const planLevel = (spec: TaskSpec, decision: PlanningDecision): ContextLevel => {
  switch (spec.kind) {
    case "chat":
    case "system":
      return "none"
    case "code":
    case "research":
      return spec.repo === undefined || decision.complexity <= 1 ? "top3" : "full"
    case "app_op":
    case "routine":
      return "top3"
  }
}

export interface ContextPlan {
  readonly level: ContextLevel
  readonly memoryK: number
  readonly codeK: number
  // Tokens the tier accepts as context, before the answer reserve is taken off (assemble does that).
  readonly budgetTokens: number
}

export interface ContextPlanner {
  readonly plan: (spec: TaskSpec, decision: PlanningDecision) => ContextPlan
}

export const makeContextPlanner = (config: ContextConfig): ContextPlanner => ({
  plan: (spec, decision) => {
    const level = planLevel(spec, decision)
    const asked = level === "none" ? { memory: 0, code: 0 } : config.levels[level]
    return {
      level,
      memoryK: asked.memory,
      // Code only exists for a task that names a repo.
      codeK: spec.repo === undefined ? 0 : asked.code,
      budgetTokens: config.budget[spec.tier],
    }
  },
})

// The tier a task without a Reflex decision is planned as: the heavy tier is the one for work that needs the repo.
export const fallbackDecision = (tier: ModelTier): PlanningDecision => ({
  complexity: tier === "heavy" ? 2 : 1,
})
