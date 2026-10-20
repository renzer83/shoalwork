import { it } from "@effect/vitest"
import { Beacon } from "@shoalwork/beacon"
import { BotRegistry } from "@shoalwork/bots"
import { newPodId, newTaskId, type PodId } from "@shoalwork/contracts"
import { nowIso } from "@shoalwork/db"
import { Effect, Stream } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { type InboundMessage, type PodInboundPort, recordInbound } from "../../src/telegram/bot.js"
import { LEAD_DEF, TestLayer } from "../support.js"

const THREAD = 101
const message: InboundMessage = { chatId: "-1001234567", threadId: THREAD, userId: "42", text: "oi equipe" }

// A Pod with its topic thread. The task row comes first: pods.task_id references tasks.
const seedPod = (threadId: number, state: "open" | "closed") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const lead = yield* (yield* BotRegistry).upsert(LEAD_DEF, "test")
    const taskId = newTaskId()
    const podId = newPodId()
    yield* sql`INSERT INTO tasks (id, bot_id, spec, state, created_at, updated_at)
      VALUES (${taskId}, ${lead.id}, '{}', 'running', ${nowIso()}, ${nowIso()})`
    yield* sql`INSERT INTO pods (id, task_id, bot_ids, thread_id, state, created_at)
      VALUES (${podId}, ${taskId}, ${JSON.stringify([lead.id])}, ${threadId}, ${state}, ${nowIso()})`
    return podId
  })

const inboundEvents = () =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    return Array.from(yield* Stream.runCollect(beacon.readAll(0, ["message.inbound"])))
  })

const errorsRaised = () =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    return Array.from(yield* Stream.runCollect(beacon.readAll(0, ["error.raised"])))
  })

// A port that records the Pod and the text it was given.
const recordingPort = () => {
  const calls: Array<{ readonly podId: PodId; readonly text: string }> = []
  const port: PodInboundPort = {
    onHumanMessage: (podId, text) => Effect.sync(() => void calls.push({ podId, text })),
  }
  return { port, calls }
}

describe("messages in a Pod's topic", () => {
  it.effect("go to the open Pod and are not an inbound message of the lead", () =>
    Effect.gen(function* () {
      const podId = yield* seedPod(THREAD, "open")
      const { port, calls } = recordingPort()
      yield* recordInbound(message, port)
      expect(calls).toEqual([{ podId, text: "oi equipe" }])
      expect(yield* inboundEvents()).toEqual([])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("keep the lead path when the Pod is closed", () =>
    Effect.gen(function* () {
      yield* seedPod(THREAD, "closed")
      const { port, calls } = recordingPort()
      yield* recordInbound(message, port)
      expect(calls).toEqual([])
      expect(yield* inboundEvents()).toHaveLength(1)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("keep the lead path when no Pod uses the thread", () =>
    Effect.gen(function* () {
      yield* seedPod(THREAD + 1, "open")
      const { port, calls } = recordingPort()
      yield* recordInbound(message, port)
      expect(calls).toEqual([])
      expect(yield* inboundEvents()).toHaveLength(1)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("keep the lead path when no Pod port is bound", () =>
    Effect.gen(function* () {
      yield* seedPod(THREAD, "open")
      yield* recordInbound(message)
      expect(yield* inboundEvents()).toHaveLength(1)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("reports a failing Pod port as error.raised and does not fail the inbound handler", () =>
    Effect.gen(function* () {
      yield* seedPod(THREAD, "open")
      const port: PodInboundPort = { onHumanMessage: () => Effect.fail(new Error("pod refused")) }
      yield* recordInbound(message, port)
      const errors = yield* errorsRaised()
      expect(errors).toHaveLength(1)
      expect(errors[0]?.payload).toMatchObject({ where: "telegram.pod" })
    }).pipe(Effect.provide(TestLayer)),
  )
})
