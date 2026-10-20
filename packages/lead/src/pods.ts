import { randomUUID } from "node:crypto"
import type { BeaconShape } from "@shoalwork/beacon"
import type { BotRegistryShape } from "@shoalwork/bots"
import {
  type BotId,
  type Event,
  type NewEvent,
  type NotFound,
  newPodId,
  type Plan,
  type PodId,
  type StatusMsg,
  type StepId,
  streamIds,
  TaskId,
} from "@shoalwork/contracts"
import { nowIso } from "@shoalwork/db"
import { Effect, Option, Schema } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import { type AuxiliaryDeps, type AuxiliaryFailed, archiveAuxiliary, createAuxiliary } from "./auxiliary.js"
import { podClosedPhrase, podHeaderPhrase, safeLine } from "./narrator.js"
import { isTerminal } from "./outcomes.js"
import {
  PodClosed,
  PodDeliveryFailed,
  PodExists,
  PodMemoryFailed,
  PodMissing,
  PodNotFinished,
  PodTopicFailed,
} from "./pod-errors.js"
import { lineOf, NOTE_MAX } from "./pod-narration.js"
import { decodePodRows, type PodRecord, toRecord } from "./pod-rows.js"
import { emit, type TaskRecord, type TaskStoreShape } from "./tasks.js"
import { describeFailure } from "./verdict.js"

// The Bot that plans and delivers: its executors, policy and Tank are the template of the auxiliaries.
export const LEAD_NAME = "lead"
// A message from Renan into a running step: one line, redacted, cut.
export const NARRATED_TYPES: ReadonlyArray<string> = ["task.state_changed", "agent.msg"]
const TASK_STREAM = "task:"

// The forum topic of a Pod, behind a port: the composition root binds it to Telegram (currents/topics.ts).
export interface PodTopicPort {
  // Creates the topic and returns its thread id.
  readonly open: (name: string) => Effect.Effect<number, unknown>
  readonly post: (threadId: number, text: string) => Effect.Effect<void, unknown>
}

export interface PodsDeps extends AuxiliaryDeps {
  readonly sql: SqlClient
  readonly beacon: BeaconShape
  readonly tasks: TaskStoreShape
  readonly bots: BotRegistryShape
  readonly topic: PodTopicPort
  // Delivers a message to a step's running task (the resume path, T-054).
  readonly resume: (taskId: TaskId, message: StatusMsg) => Effect.Effect<void, unknown>
  // Episodic summary of a closed Pod, in memory scope "pod" (T-036).
  readonly remember: (podId: PodId, summary: string) => Effect.Effect<void, unknown>
}

export interface OpenedPod {
  readonly pod: PodRecord
  // Every step of the plan with the Bot that runs it: the fixed owner, or the auxiliary created for it.
  readonly assignments: ReadonlyMap<StepId, BotId>
}

export type HumanOutcome = { readonly kind: "delivered"; readonly taskId: TaskId } | { readonly kind: "idle" }

const describe = (cause: unknown): string => describeFailure(cause).tag

export const makePods = (deps: PodsDeps) => {
  const { sql, beacon, tasks, bots, topic } = deps

  const loadRows = (rows: ReadonlyArray<unknown>) =>
    Effect.gen(function* () {
      const [row] = yield* decodePodRows(rows)
      return row === undefined ? undefined : yield* toRecord(row)
    })

  const podById = (podId: PodId) =>
    Effect.gen(function* () {
      const rows = yield* sql`SELECT * FROM pods WHERE id = ${podId}`
      const pod = yield* loadRows(rows)
      if (pod === undefined) {
        return yield* Effect.fail(new PodMissing({ podId }))
      }
      return pod
    })

  const openPodById = (podId: PodId) =>
    Effect.gen(function* () {
      const pod = yield* podById(podId)
      if (pod.state !== "open") {
        return yield* Effect.fail(new PodClosed({ podId }))
      }
      return pod
    })

  // The open Pod of a plan's step task: step tasks name their plan in `parent.planId` (T-050 dispatches them).
  const openPodOfPlan = (planId: string) =>
    Effect.gen(function* () {
      const rows = yield* sql`SELECT pods.* FROM pods JOIN plans ON plans.task_id = pods.task_id
        WHERE plans.id = ${planId} AND pods.state = 'open'`
      return yield* loadRows(rows)
    })

  // Narration never fails the caller: a message that does not reach the topic is logged.
  const post = (pod: PodRecord, text: string) =>
    topic
      .post(pod.threadId, text)
      .pipe(Effect.catch((cause) => Effect.logWarning("pod message not sent", describe(cause))))

  // Opens the Pod of an approved plan: topic with the plan as its header, one auxiliary Bot per step without an
  // owner, and the Pod row. A failure after the first auxiliary archives the ones already created.
  const open = (
    plan: Plan,
  ): Effect.Effect<OpenedPod, PodExists | PodTopicFailed | AuxiliaryFailed | NotFound | SqlError> =>
    Effect.gen(function* () {
      const rows = yield* sql`SELECT * FROM pods WHERE task_id = ${plan.taskId}`
      const existing = yield* loadRows(rows)
      if (existing !== undefined) {
        return yield* Effect.fail(new PodExists({ podId: existing.id }))
      }
      const lead = yield* bots.getByName(LEAD_NAME)
      const threadId = yield* topic
        .open(`pod-${plan.taskId.slice("task_".length, "task_".length + 6)}`)
        .pipe(Effect.mapError((cause) => new PodTopicFailed({ cause: describe(cause) })))
      const created: Array<BotId> = []
      const assignments = new Map<StepId, BotId>()
      const build = Effect.gen(function* () {
        let index = 0
        for (const step of plan.steps) {
          if (step.assignedBot !== undefined) {
            assignments.set(step.id, step.assignedBot)
            continue
          }
          index += 1
          const aux = yield* createAuxiliary(deps, { taskId: plan.taskId, index, step, lead })
          created.push(aux.id)
          assignments.set(step.id, aux.id)
        }
        const botIds = [...new Set(assignments.values())]
        const podId = newPodId()
        yield* sql`INSERT INTO pods (id, task_id, bot_ids, thread_id, state, created_at)
          VALUES (${podId}, ${plan.taskId}, ${JSON.stringify(botIds)}, ${threadId}, 'open', ${nowIso()})`
        return { id: podId, taskId: plan.taskId, botIds, threadId, state: "open" as const }
      })
      const pod = yield* build.pipe(
        Effect.onError(() =>
          Effect.forEach(created, (botId) => archiveAuxiliary(bots, botId, plan.taskId), {
            discard: true,
          }).pipe(Effect.ignore),
        ),
      )
      yield* post(pod, podHeaderPhrase(plan.steps.map((step) => step.title)))
      return { pod, assignments }
    })

  // Narrates the events of the plan's steps in the Pod's topic: state changes of the step tasks and their
  // agent messages. Events of tasks outside a Pod, and of Pods already closed, are ignored.
  const narrate = (event: Event): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      if (!NARRATED_TYPES.includes(event.type) || !event.streamId.startsWith(TASK_STREAM)) {
        return
      }
      const taskId = Schema.decodeUnknownOption(TaskId)(event.streamId.slice(TASK_STREAM.length))
      if (Option.isNone(taskId)) {
        return
      }
      const record = yield* tasks.get(taskId.value).pipe(Effect.option)
      if (Option.isNone(record)) {
        return
      }
      const parent = record.value.spec.parent
      if (parent === undefined || !("planId" in parent)) {
        return
      }
      const pod = yield* openPodOfPlan(parent.planId)
      if (pod === undefined) {
        return
      }
      const line = yield* lineOf(bots, event, record.value)
      if (Option.isSome(line)) {
        yield* post(pod, line.value)
      }
    })

  // A message from Renan goes to the running step of the Pod: recorded as agent.msg on the step's stream, then
  // handed to the step through resume. Idle when no Pod Bot has a running task.
  const onHumanMessage = (
    podId: PodId,
    text: string,
  ): Effect.Effect<HumanOutcome, PodMissing | PodClosed | PodDeliveryFailed | SqlError> =>
    Effect.gen(function* () {
      const pod = yield* openPodById(podId)
      let running: TaskRecord | undefined
      for (const botId of pod.botIds) {
        const records = yield* tasks.listByBot(botId)
        running = records.find((record) => record.state === "running")
        if (running !== undefined) {
          break
        }
      }
      if (running === undefined) {
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
      yield* emit(beacon, event)
      yield* deps
        .resume(taskId, message)
        .pipe(Effect.mapError((cause) => new PodDeliveryFailed({ taskId, cause: describe(cause) })))
      return { kind: "delivered", taskId } satisfies HumanOutcome
    })

  // Closes the Pod once every auxiliary Bot has finished its step. Order: episodic memory (a failure leaves the Pod
  // open for a retry), archive the auxiliaries, mark the Pod closed, then the closing message in the topic.
  const close = (
    podId: PodId,
  ): Effect.Effect<void, PodMissing | PodClosed | PodNotFinished | PodMemoryFailed | NotFound | SqlError> =>
    Effect.gen(function* () {
      const pod = yield* openPodById(podId)
      const auxiliaries: Array<BotId> = []
      let done = 0
      let failed = 0
      for (const botId of pod.botIds) {
        const bot = yield* bots.get(botId)
        if (bot.kind !== "auxiliary") {
          continue
        }
        const records = yield* tasks.listByBot(botId)
        const finished = records.length > 0 && records.every((record) => isTerminal(record.state))
        if (!finished) {
          return yield* Effect.fail(new PodNotFinished({ podId }))
        }
        auxiliaries.push(botId)
        done += records.filter((record) => record.state === "done").length
        failed += records.filter((record) => record.state === "failed").length
      }
      const summary = `${auxiliaries.length} passo(s) auxiliar(es): ${done} concluído(s), ${failed} falhou(aram).`
      yield* deps
        .remember(pod.id, summary)
        .pipe(Effect.mapError((cause) => new PodMemoryFailed({ podId, cause: describe(cause) })))
      for (const botId of auxiliaries) {
        yield* archiveAuxiliary(bots, botId, pod.taskId)
      }
      yield* sql`UPDATE pods SET state = 'closed', closed_at = ${nowIso()} WHERE id = ${podId}`
      yield* post(pod, podClosedPhrase(summary))
    })

  return { open, narrate, onHumanMessage, close }
}

export type Pods = ReturnType<typeof makePods>
