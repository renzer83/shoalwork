import type { PodDetail, PodStep, PodUsage } from "@shoalwork/api-client"
import { type Event, EventPayloads } from "@shoalwork/contracts"
import { Option, Schema } from "effect"

// The live events a Pod screen reacts to. Other types never reach it.
export const POD_LIVE_TYPES = [
  "task.state_changed",
  "usage.recorded",
  "agent.msg",
  "pod.opened",
  "pod.closed",
] as const

// Patched: the snapshot changed in place (a step recoloured, a cost added). Refresh: the snapshot must be fetched
// again (a message, a Pod opened or closed, a task the snapshot does not know). Ignore: nothing here.
export type PodReaction =
  | { readonly kind: "ignore" }
  | { readonly kind: "refresh" }
  | { readonly kind: "patched"; readonly detail: PodDetail }

const decodeStateChange = Schema.decodeUnknownOption(EventPayloads["task.state_changed"])
const decodeUsage = Schema.decodeUnknownOption(EventPayloads["usage.recorded"])

const withStep = (detail: PodDetail, stepId: string, change: (step: PodStep) => PodStep): PodDetail => ({
  ...detail,
  steps: detail.steps.map((step) => (step.id === stepId ? change(step) : step)),
})

const addUsage = (a: PodUsage, b: PodUsage): PodUsage => ({
  usd: a.usd + b.usd,
  tokensIn: a.tokensIn + b.tokensIn,
  tokensOut: a.tokensOut + b.tokensOut,
})

// Pure: the same snapshot and event always give the same reaction.
export const reactTo = (detail: PodDetail, event: Event): PodReaction => {
  if (event.type === "agent.msg" || event.type === "pod.opened" || event.type === "pod.closed") {
    return { kind: "refresh" }
  }
  if (event.type === "task.state_changed") {
    const change = decodeStateChange(event.payload)
    if (Option.isNone(change)) return { kind: "ignore" }
    const step = detail.steps.find((candidate) => candidate.taskId === change.value.taskId)
    if (step === undefined) {
      // A step attempt the snapshot does not know yet; any other task's change is refetched at most once per burst.
      return { kind: "refresh" }
    }
    const to = change.value.to
    return { kind: "patched", detail: withStep(detail, step.id, (current) => ({ ...current, state: to })) }
  }
  if (event.type === "usage.recorded") {
    const usage = decodeUsage(event.payload)
    if (Option.isNone(usage)) return { kind: "ignore" }
    const step = detail.steps.find((candidate) => candidate.taskId === usage.value.taskId)
    if (step === undefined) return { kind: "refresh" }
    const delta = usage.value.usage
    return {
      kind: "patched",
      detail: withStep(detail, step.id, (current) => ({
        ...current,
        usage: addUsage(current.usage, {
          usd: delta.usd,
          tokensIn: delta.tokensIn,
          tokensOut: delta.tokensOut,
        }),
      })),
    }
  }
  return { kind: "ignore" }
}
