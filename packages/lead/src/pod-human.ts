import { randomUUID } from "node:crypto"
import type { BeaconShape } from "@shoalwork/beacon"
import { type NewEvent, type PodId, type StatusMsg, streamIds, type TaskId } from "@shoalwork/contracts"
import { Effect } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import { safeLine } from "./narrator.js"
import { type PodClosed, PodDeliveryFailed, type PodMissing } from "./pod-errors.js"
import { NOTE_MAX } from "./pod-narration.js"
import type { PodRecord } from "./pod-rows.js"
import { emit, type TaskRecord, type TaskStoreShape } from "./tasks.js"
import { describeFailure } from "./verdict.js"

// Where a message in a Pod's topic came from (the connector knows; the Pod only records it).
export interface HumanSender {
  readonly userId: string
  readonly chatId?: string | undefined
}

export type HumanOutcome = { readonly kind: "delivered"; readonly taskId: TaskId } | { readonly kind: "idle" }

export const IDLE_REPLY = "Nenhum passo em execução neste momento."

// A message that reached no running step is still an event (R12): message.inbound with the Pod's id, written to the
// task's stream. The conversation of the Lead ignores inbound messages that name a Pod.
export const recordIdleMessage = (beacon: BeaconShape, pod: PodRecord, text: string, from?: HumanSender) =>
  emit(beacon, {
    streamId: streamIds.task(pod.taskId),
    type: "message.inbound",
    payload: {
      channel: "telegram",
      userId: from?.userId ?? "unknown",
      text: safeLine(text, NOTE_MAX),
      threadId: String(pod.threadId),
      podId: pod.id,
      ...(from?.chatId === undefined ? {} : { chatId: from.chatId }),
    },
    actor: `user:telegram:${from?.userId ?? "unknown"}`,
    correlationId: randomUUID(),
  })

export interface HumanMessageDeps {
  readonly beacon: BeaconShape
  readonly tasks: TaskStoreShape
  readonly resume: (taskId: TaskId, message: StatusMsg) => Effect.Effect<void, unknown>
  readonly openPodById: (podId: PodId) => Effect.Effect<PodRecord, PodMissing | PodClosed | SqlError>
  readonly post: (pod: PodRecord, text: string) => Effect.Effect<void>
  // The id of the Pod's plan: only the tasks of its steps are running steps of the Pod.
  readonly planIdOf: (pod: PodRecord) => Effect.Effect<string | undefined, SqlError>
}

// A message from Renan goes to the running step of the Pod: recorded as agent.msg on the step's stream, then handed
// to the step through resume. With no running step it is answered in the topic and recorded as message.inbound.
export const makeOnHumanMessage =
  (deps: HumanMessageDeps) =>
  (
    podId: PodId,
    text: string,
    from?: HumanSender,
  ): Effect.Effect<HumanOutcome, PodMissing | PodClosed | PodDeliveryFailed | SqlError> =>
    Effect.gen(function* () {
      const pod = yield* deps.openPodById(podId)
      const planId = yield* deps.planIdOf(pod)
      let running: TaskRecord | undefined
      for (const botId of pod.botIds) {
        const records = yield* deps.tasks.listByBot(botId)
        running = records.find((record) => {
          const parent = record.spec.parent
          return (
            record.state === "running" &&
            parent !== undefined &&
            "planId" in parent &&
            parent.planId === planId
          )
        })
        if (running !== undefined) {
          break
        }
      }
      if (running === undefined) {
        yield* recordIdleMessage(deps.beacon, pod, text, from)
        yield* deps.post(pod, IDLE_REPLY)
        return { kind: "idle" } satisfies HumanOutcome
      }
      const taskId = running.spec.id
      const message: StatusMsg = {
        kind: "status",
        bot: running.spec.botId,
        state: "working",
        note: safeLine(text, NOTE_MAX),
      }
      const event: NewEvent = {
        streamId: streamIds.task(taskId),
        type: "agent.msg",
        payload: message,
        actor: "human",
        correlationId: randomUUID(),
      }
      yield* emit(deps.beacon, event)
      yield* deps
        .resume(taskId, message)
        .pipe(
          Effect.mapError((cause) => new PodDeliveryFailed({ taskId, cause: describeFailure(cause).tag })),
        )
      return { kind: "delivered", taskId } satisfies HumanOutcome
    })
