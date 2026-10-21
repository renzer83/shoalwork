import type { StepState } from "@shoalwork/api-client"
import type { MessageKey } from "../../i18n/index.js"

// What a step's colour says, grouped: the screen maps each tone to a theme colour.
export type StepTone = "done" | "active" | "waiting" | "failed" | "idle"

export const toneOf = (state: StepState): StepTone => {
  if (state === "done") return "done"
  if (state === "failed") return "failed"
  if (state === "pending" || state === "cancelled") return "idle"
  if (state === "waiting_approval") return "waiting"
  return "active"
}

// The label of each step state is a message key: the screen translates it.
export const STATE_KEY: Readonly<Record<StepState, MessageKey>> = {
  pending: "dag.state.pending",
  received: "dag.state.received",
  planning: "dag.state.planning",
  ready: "dag.state.ready",
  running: "dag.state.running",
  waiting_approval: "dag.state.waiting_approval",
  verifying: "dag.state.verifying",
  done: "dag.state.done",
  failed: "dag.state.failed",
  cancelled: "dag.state.cancelled",
}
