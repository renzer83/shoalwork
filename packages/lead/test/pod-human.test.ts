import { it } from "@effect/vitest"
import { Beacon } from "@shoalwork/beacon"
import { newTaskId, type TaskSpec } from "@shoalwork/contracts"
import { Effect, Stream } from "effect"
import { describe, expect } from "vitest"
import { NO_TOPICS } from "../src/planning.js"
import { IDLE_REPLY } from "../src/pod-human.js"
import { makePods } from "../src/pods.js"
import { PodLayer, setupPods } from "./pods-support.js"
import { specFor } from "./support.js"

const runningTask = (s: Effect.Success<ReturnType<typeof setupPods>>, over: Partial<Omit<TaskSpec, "id">>) =>
  Effect.gen(function* () {
    const spec: TaskSpec = { ...specFor(s.worker, over), id: newTaskId() }
    yield* s.tasks.insert(spec)
    yield* s.tasks.update(spec.id, { state: "running" })
    return spec
  })

describe("Pod human messages", () => {
  it.effect("answers in the topic and records message.inbound with the Pod when no step runs", () =>
    Effect.gen(function* () {
      const s = yield* setupPods(["Instruções."])
      const opened = yield* s.pods.open(s.plan)
      // The Bot of a Pod runs another task of its own: it is not a step of the plan.
      yield* runningTask(s, {})
      const outcome = yield* s.pods.onHumanMessage(opened.pod.id, "como vai?", {
        userId: "42",
        chatId: "-100",
      })
      expect(outcome).toEqual({ kind: "idle" })
      expect(s.topic.posts.at(-1)).toEqual({ threadId: opened.pod.threadId, text: IDLE_REPLY })
      expect(s.resumes).toHaveLength(0)
      const beacon = yield* Beacon
      const inbound = Array.from(yield* Stream.runCollect(beacon.readAll(0, ["message.inbound"])))
      expect(inbound).toHaveLength(1)
      expect(inbound[0]?.payload).toMatchObject({ podId: opened.pod.id, userId: "42", text: "como vai?" })
    }).pipe(Effect.provide(PodLayer)),
  )

  it.effect("delivers the message to the running step of the plan, not to another task of the Bot", () =>
    Effect.gen(function* () {
      const s = yield* setupPods(["Instruções."])
      const opened = yield* s.pods.open(s.plan)
      yield* runningTask(s, {})
      const step = yield* runningTask(s, { parent: { planId: s.plan.id, stepId: s.stepOwned } })
      const outcome = yield* s.pods.onHumanMessage(opened.pod.id, "use X", { userId: "42" })
      expect(outcome).toEqual({ kind: "delivered", taskId: step.id })
      expect(s.resumes.map((r) => r.taskId)).toEqual([step.id])
      const beacon = yield* Beacon
      expect(Array.from(yield* Stream.runCollect(beacon.readAll(0, ["message.inbound"])))).toHaveLength(0)
    }).pipe(Effect.provide(PodLayer)),
  )
})

describe("Pods without Telegram", () => {
  it.effect("open and close with the no-topic port: thread 0, nothing posted", () =>
    Effect.gen(function* () {
      const s = yield* setupPods(["Instruções."])
      const pods = makePods({
        sql: s.sql,
        beacon: yield* Beacon,
        tasks: s.tasks,
        bots: s.bots,
        topic: NO_TOPICS,
        ask: s.script.ask,
        resume: () => Effect.void,
        remember: () => Effect.void,
      })
      const opened = yield* pods.open(s.plan)
      expect(opened.pod.threadId).toBe(0)
      yield* pods.close(opened.pod.id, { planFinished: true })
      expect(s.topic.posts).toEqual([])
    }).pipe(Effect.provide(PodLayer)),
  )
})
