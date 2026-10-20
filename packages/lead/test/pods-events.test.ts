import { it } from "@effect/vitest"
import { Beacon } from "@shoalwork/beacon"
import { newTaskId, streamIds, type TaskId } from "@shoalwork/contracts"
import { Effect, Stream } from "effect"
import { describe, expect } from "vitest"
import { auxiliaryDef, auxiliaryName } from "../src/auxiliary.js"
import { PodLayer, setupPods, stepOf } from "./pods-support.js"
import { specFor } from "./support.js"

// The events a Pod writes on its task's stream, and the plan as stored after opening.
const podEvents = (taskId: TaskId) =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    const events = yield* Stream.runCollect(beacon.readStream(streamIds.task(taskId)))
    return Array.from(events).filter((event) => event.type === "pod.opened" || event.type === "pod.closed")
  })

describe("Pods events and stored plan", () => {
  it.effect("opening writes pod.opened on the task's stream, and the plan keeps the Bot of every step", () =>
    Effect.gen(function* () {
      const s = yield* setupPods(["Instruções do passo novo."])
      const opened = yield* s.pods.open(s.plan)
      const events = yield* podEvents(s.plan.taskId)
      expect(events.map((event) => event.type)).toEqual(["pod.opened"])
      expect(events[0]?.payload).toEqual({
        podId: opened.pod.id,
        taskId: s.plan.taskId,
        threadId: opened.pod.threadId,
        botIds: opened.pod.botIds,
      })
      expect(events[0]?.actor).toBe("lead:pods")

      const rows = yield* s.sql<{ readonly plan: string }>`SELECT plan FROM plans WHERE id = ${s.plan.id}`
      const stored = JSON.parse(rows[0]?.plan ?? "null") as { readonly steps: ReadonlyArray<unknown> }
      const owners = stored.steps.map((step) => (step as { readonly assignedBot?: string }).assignedBot)
      expect(owners).toEqual([s.worker.id, opened.assignments.get(s.stepNew)])
    }).pipe(Effect.provide(PodLayer)),
  )

  it.effect("closing writes pod.closed with the summary on the same stream", () =>
    Effect.gen(function* () {
      const s = yield* setupPods(["Instruções."])
      const opened = yield* s.pods.open(s.plan)
      const auxId = opened.assignments.get(s.stepNew)
      if (auxId === undefined) throw new Error("the new step has no auxiliary")
      const auxTask = {
        ...specFor(yield* s.bots.get(auxId), { parent: { planId: s.plan.id, stepId: s.stepNew } }),
        id: newTaskId(),
      }
      yield* s.tasks.insert(auxTask)
      yield* s.tasks.update(auxTask.id, { state: "done" })
      yield* s.pods.close(opened.pod.id)
      const closed = (yield* podEvents(s.plan.taskId)).find((event) => event.type === "pod.closed")
      expect(closed?.payload).toEqual({
        podId: opened.pod.id,
        taskId: s.plan.taskId,
        summary: "1 passo(s) auxiliar(es): 1 concluído(s), 0 falhou(aram).",
      })
    }).pipe(Effect.provide(PodLayer)),
  )

  it.effect("a name held by an archived auxiliary is not reused: the next number is taken", () =>
    Effect.gen(function* () {
      const s = yield* setupPods(["Instruções do passo novo."])
      const old = yield* s.bots.upsert(
        auxiliaryDef(
          { taskId: s.plan.taskId, index: 1, step: stepOf(s.stepNew, "Old", undefined), lead: s.lead },
          "instruções antigas",
        ),
        "test",
      )
      yield* s.bots.setState(old.id, "archived")
      const opened = yield* s.pods.open(s.plan)
      const auxId = opened.assignments.get(s.stepNew)
      if (auxId === undefined) throw new Error("the new step has no auxiliary")
      const aux = yield* s.bots.get(auxId)
      expect(aux.name).toBe(auxiliaryName(s.plan.taskId, 2))
      expect(auxId).not.toBe(old.id)
    }).pipe(Effect.provide(PodLayer)),
  )
})
