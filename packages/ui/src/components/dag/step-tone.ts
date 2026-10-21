import type { StepState } from "@shoalwork/api-client"

// What a step's colour says, grouped: the screen maps each tone to a theme colour.
export type StepTone = "done" | "active" | "waiting" | "failed" | "idle"

export const toneOf = (state: StepState): StepTone => {
  if (state === "done") return "done"
  if (state === "failed") return "failed"
  if (state === "pending" || state === "cancelled") return "idle"
  if (state === "waiting_approval") return "waiting"
  return "active"
}

export const STATE_LABEL: Readonly<Record<StepState, string>> = {
  pending: "pending",
  received: "received",
  planning: "planning",
  ready: "ready",
  running: "running",
  waiting_approval: "waiting approval",
  verifying: "verifying",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
}
