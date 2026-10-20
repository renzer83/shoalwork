import { it } from "@effect/vitest"
import { Beacon } from "@shoalwork/beacon"
import { newPodId, newTaskId, streamIds } from "@shoalwork/contracts"
import { Effect, Stream } from "effect"
import { describe, expect } from "vitest"
import { auxiliaryName } from "../src/auxiliary.js"
import { botNamed, failedTag, failure, PodLayer, setupPods, stepOf } from "./pods-support.js"
import { specFor } from "./support.js"

describe("Pods", () => {
  it.effect("opens a Pod with a topic named after the task and the plan as its header", () =>
    Effect.gen(function* () {
      const s = yield* setupPods(["Ler o código antes."])
      const opened = yield* s.pods.open(s.plan)
      expect(s.topic.opened).toEqual([`pod-${s.plan.taskId.slice("task_".length, "task_".length + 6)}`])
      expect(s.topic.posts[0]?.threadId).toBe(opened.pod.threadId)
      expect(s.topic.posts[0]?.text).toContain("Plano com 2 passo(s):")
      expect(s.topic.posts[0]?.text).toContain("1. Owned step")
      expect(s.topic.posts[0]?.text).toContain("2. New step")
      const rows = yield* s.sql<{ readonly state: string; readonly thread_id: number }>`
        SELECT state, thread_id FROM pods WHERE task_id = ${s.plan.taskId}`
      expect(rows).toEqual([{ state: "open", thread_id: opened.pod.threadId }])
    }).pipe(Effect.provide(PodLayer)),
  )

  it.effect("gives the fixed owner its own Bot and creates one auxiliary for the step without owner", () =>
    Effect.gen(function* () {
      const s = yield* setupPods(["Instruções do passo novo."])
      const opened = yield* s.pods.open(s.plan)
      expect(opened.assignments.get(s.stepOwned)).toBe(s.worker.id)
      const auxId = opened.assignments.get(s.stepNew)
      if (auxId === undefined) throw new Error("the new step has no auxiliary")
      const aux = yield* s.bots.get(auxId)
      expect(aux.name).toBe(auxiliaryName(s.plan.taskId, 1))
      expect(aux.kind).toBe("auxiliary")
      expect(opened.pod.botIds).toEqual([s.worker.id, aux.id])
    }).pipe(Effect.provide(PodLayer)),
  )

  it.effect("refuses a second Pod for the same plan", () =>
    Effect.gen(function* () {
      const s = yield* setupPods(["Instruções."])
      yield* s.pods.open(s.plan)
      const second = yield* s.pods.open(s.plan).pipe(Effect.result)
      expect(failedTag(second)).toBe("PodExists")
    }).pipe(Effect.provide(PodLayer)),
  )

  it.effect("a topic that cannot be opened leaves no Pod and no auxiliary Bot", () =>
    Effect.gen(function* () {
      const s = yield* setupPods(["Instruções."], { failOpen: true })
      const result = yield* s.pods.open(s.plan).pipe(Effect.result)
      expect(failedTag(result)).toBe("PodTopicFailed")
      const rows = yield* s.sql<{ readonly id: string }>`SELECT id FROM pods WHERE task_id = ${s.plan.taskId}`
      expect(rows).toEqual([])
      const names = (yield* s.bots.list()).map((bot) => bot.name)
      expect(names.some((name) => name.startsWith("aux-"))).toBe(false)
    }).pipe(Effect.provide(PodLayer)),
  )

  it.effect("an auxiliary that cannot be created archives the ones already created", () =>
    Effect.gen(function* () {
      const s = yield* setupPods(["Instruções do primeiro.", failure("model down")])
      const plan = {
        ...s.plan,
        steps: [stepOf(s.stepNew, "First", undefined), stepOf(s.stepOwned, "Second", undefined)],
      }
      const result = yield* s.pods.open(plan).pipe(Effect.result)
      expect(failedTag(result)).toBe("AuxiliaryFailed")
      const first = botNamed(yield* s.bots.list(), auxiliaryName(s.plan.taskId, 1))
      expect(first?.state).toBe("archived")
      const rows = yield* s.sql<{ readonly id: string }>`SELECT id FROM pods WHERE task_id = ${s.plan.taskId}`
      expect(rows).toEqual([])
    }).pipe(Effect.provide(PodLayer)),
  )

  it.effect("a human message reaches the running step through resume and is recorded on its stream", () =>
    Effect.gen(function* () {
      const s = yield* setupPods(["Instruções."])
      const opened = yield* s.pods.open(s.plan)
      const beacon = yield* Beacon
      const running = {
        ...specFor(s.worker, { parent: { planId: s.plan.id, stepId: s.stepOwned } }),
        id: newTaskId(),
      }
      yield* s.tasks.insert(running)
      yield* s.tasks.update(running.id, { state: "running" })

      const outcome = yield* s.pods.onHumanMessage(opened.pod.id, "pare e revise o teste")
      expect(outcome).toEqual({ kind: "delivered", taskId: running.id })
      expect(s.resumes).toHaveLength(1)
      expect(s.resumes[0]?.message).toMatchObject({ kind: "status", note: "pare e revise o teste" })

      const stream = yield* Stream.runCollect(beacon.readStream(streamIds.task(running.id)))
      const messages = Array.from(stream).filter((event) => event.type === "agent.msg")
      expect(messages).toHaveLength(1)
      expect(messages[0]?.actor).toBe("human")
    }).pipe(Effect.provide(PodLayer)),
  )

  it.effect("a human message with no running step is reported as idle and delivered nowhere", () =>
    Effect.gen(function* () {
      const s = yield* setupPods(["Instruções."])
      const opened = yield* s.pods.open(s.plan)
      const outcome = yield* s.pods.onHumanMessage(opened.pod.id, "oi")
      expect(outcome).toEqual({ kind: "idle" })
      expect(s.resumes).toEqual([])
    }).pipe(Effect.provide(PodLayer)),
  )

  it.effect(
    "closing waits for every auxiliary step, archives them, remembers the summary and closes the Pod",
    () =>
      Effect.gen(function* () {
        const s = yield* setupPods(["Instruções."])
        const opened = yield* s.pods.open(s.plan)
        const exit = yield* s.pods.close(opened.pod.id).pipe(Effect.result)
        expect(failedTag(exit)).toBe("PodNotFinished")

        const auxId = opened.assignments.get(s.stepNew)
        if (auxId === undefined) throw new Error("the new step has no auxiliary")
        const auxTask = {
          ...specFor(yield* s.bots.get(auxId), { parent: { planId: s.plan.id, stepId: s.stepNew } }),
          id: newTaskId(),
        }
        yield* s.tasks.insert(auxTask)
        yield* s.tasks.update(auxTask.id, { state: "done" })

        yield* s.pods.close(opened.pod.id)
        expect(s.remembered).toHaveLength(1)
        expect(s.remembered[0]?.summary).toContain("1 passo(s) auxiliar(es): 1 concluído(s), 0 falhou(aram).")
        expect(botNamed(yield* s.bots.list(), auxiliaryName(s.plan.taskId, 1))?.state).toBe("archived")
        const rows = yield* s.sql<{
          readonly state: string
        }>`SELECT state FROM pods WHERE id = ${opened.pod.id}`
        expect(rows).toEqual([{ state: "closed" }])
        expect(s.topic.posts.at(-1)?.text.startsWith("Pod fechado.")).toBe(true)

        const again = yield* s.pods.close(opened.pod.id).pipe(Effect.result)
        expect(failedTag(again)).toBe("PodClosed")
      }).pipe(Effect.provide(PodLayer)),
  )

  it.effect("closing a Pod that does not exist fails with PodMissing", () =>
    Effect.gen(function* () {
      const s = yield* setupPods(["Instruções."])
      const result = yield* s.pods.close(newPodId()).pipe(Effect.result)
      expect(failedTag(result)).toBe("PodMissing")
    }).pipe(Effect.provide(PodLayer)),
  )

  it.effect("narrates a step's state change in the Pod's topic and ignores tasks outside any Pod", () =>
    Effect.gen(function* () {
      const s = yield* setupPods(["Instruções."])
      const opened = yield* s.pods.open(s.plan)
      const beacon = yield* Beacon
      const auxId = opened.assignments.get(s.stepNew)
      if (auxId === undefined) throw new Error("the new step has no auxiliary")
      const stepTask = {
        ...specFor(yield* s.bots.get(auxId), { parent: { planId: s.plan.id, stepId: s.stepNew } }),
        id: newTaskId(),
      }
      yield* s.tasks.insert(stepTask)
      const before = s.topic.posts.length
      const started = yield* beacon.append({
        streamId: streamIds.task(stepTask.id),
        type: "task.state_changed",
        payload: { taskId: stepTask.id, from: "ready", to: "running" },
        actor: "test",
        correlationId: "corr-pod",
      })
      yield* s.pods.narrate(started)
      expect(s.topic.posts.length).toBe(before + 1)
      expect(s.topic.posts.at(-1)?.threadId).toBe(opened.pod.threadId)
      expect(s.topic.posts.at(-1)?.text).toContain("Comecei.")

      const loose = { ...specFor(s.worker), id: newTaskId() }
      yield* s.tasks.insert(loose)
      const outside = yield* beacon.append({
        streamId: streamIds.task(loose.id),
        type: "task.state_changed",
        payload: { taskId: loose.id, from: "ready", to: "running" },
        actor: "test",
        correlationId: "corr-loose",
      })
      yield* s.pods.narrate(outside)
      expect(s.topic.posts.length).toBe(before + 1)
    }).pipe(Effect.provide(PodLayer)),
  )
})
