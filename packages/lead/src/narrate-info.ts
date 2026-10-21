import type { TaskOrigin, TaskSpec } from "@shoalwork/contracts"

// What the narrator needs from the stored task, read once.
export interface TaskInfo {
  readonly origin: TaskOrigin
  readonly correlationId: string | undefined
  // Whether the task is a step of a plan (its lines go to the Pod's topic, pods.ts, never to the Bot's topic).
  readonly podStep: boolean
}

// Tasks asked in a chat (Telegram or the app) get the full narration; the others only the start and the end.
export const askedInChat = (origin: TaskOrigin): boolean => origin === "telegram" || origin === "app"

export const infoFrom = (spec: TaskSpec): TaskInfo => ({
  origin: spec.origin,
  correlationId: spec.correlationId,
  podStep: spec.parent !== undefined && "planId" in spec.parent,
})
