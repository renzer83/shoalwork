import { type Event, EventPayloads, TaskId } from "@shoalwork/contracts"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { isTerminal } from "./outcomes.js"
import type { Carry } from "./retry.js"

// Messages Renan sent into a Pod's topic for a step that is running. A running executor takes no input, so the
// note waits here and the next round of the task (a retry or a resumed approval) carries it in its prompt.
const NOTES_PER_TASK = 5

export interface PodNotesShape {
  readonly push: (taskId: TaskId, note: string) => Effect.Effect<void>
  // The task is over: its waiting notes go away.
  readonly clear: (taskId: TaskId) => Effect.Effect<void>
  // The carry with the task's waiting notes added (they are taken: each reaches one round). Without a carry there
  // is no round to continue, so the notes stay.
  readonly attach: (taskId: TaskId, carry: Carry | undefined) => Effect.Effect<Carry | undefined>
}

export const makePodNotes = (): PodNotesShape => {
  const waiting = new Map<TaskId, Array<string>>()
  return {
    push: (taskId, note) =>
      Effect.sync(() => {
        const notes = waiting.get(taskId) ?? []
        waiting.set(taskId, [...notes, note].slice(-NOTES_PER_TASK))
      }),
    clear: (taskId) =>
      Effect.sync(() => {
        waiting.delete(taskId)
      }),
    attach: (taskId, carry) =>
      Effect.sync(() => {
        const notes = waiting.get(taskId)
        if (carry === undefined || notes === undefined) return carry
        waiting.delete(taskId)
        return { ...carry, notes: [...(carry.notes ?? []), ...notes] }
      }),
  }
}

export class PodNotes extends Context.Service<PodNotes, PodNotesShape>()("@shoalwork/PodNotes") {}

export const PodNotesLive: Layer.Layer<PodNotes> = Layer.sync(PodNotes, makePodNotes)

const StateChanged = Schema.decodeUnknownOption(EventPayloads["task.state_changed"])
const TASK_STREAM = "task:"

// A task that reached a terminal state takes no more rounds: its waiting notes are dropped.
export const forgetNotes = (notes: PodNotesShape, event: Event): Effect.Effect<void> => {
  if (event.type !== "task.state_changed" || !event.streamId.startsWith(TASK_STREAM)) return Effect.void
  const taskId = Schema.decodeUnknownOption(TaskId)(event.streamId.slice(TASK_STREAM.length))
  const change = StateChanged(event.payload)
  return Option.isSome(taskId) && Option.isSome(change) && isTerminal(change.value.to)
    ? notes.clear(taskId.value)
    : Effect.void
}
