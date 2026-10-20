import { it } from "@effect/vitest"
import { Beacon } from "@shoalwork/beacon"
import { newStepId } from "@shoalwork/contracts"
import { Deferred, Effect, Fiber, Stream } from "effect"
import { describe, expect } from "vitest"
import { IntegrationFailed } from "../src/plan/integration.js"
import { PLAN_RESTART_REASON } from "../src/plan-flow.js"
import { harness, podStates } from "./plan-flow-support.js"
import { PodLayer, setupPods } from "./pods-support.js"

const PR = "https://github.com/renzer83/shoalwork-sandbox/pull/9"

const stateOrder = (root: string) =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    const events = Array.from(yield* Stream.runCollect(beacon.readAll(0)))
    return events
      .filter((event) => event.streamId === `task:${root}`)
      .map((event) =>
        event.type === "task.state_changed" ? `state:${(event.payload as { to: string }).to}` : event.type,
      )
  })

describe("plan flow", () => {
  it.effect("plans, opens the Pod, runs two steps in parallel, merges into one PR and closes the Pod", () =>
    Effect.gen(function* () {
      const s = yield* setupPods(["Instruções do passo C."])
      const bothRunning = yield* Deferred.make<void>()
      let running = 0
      let peak = 0
      const h = yield* harness(s, {
        runStep: (record) =>
          Effect.gen(function* () {
            // A and B rendezvous: neither finishes until both are running (no clock involved).
            if (record.spec.title !== "Step C") {
              running += 1
              peak = Math.max(peak, running)
              if (running === 2) yield* Deferred.succeed(bothRunning, undefined)
              yield* Deferred.await(bothRunning)
              running -= 1
            }
            const verdict = {
              kind: "ok" as const,
              summary: "d",
              evidence: [`bot/x/${record.spec.id}`],
              cost: { tokensIn: 1, tokensOut: 1, usd: 0.5, seconds: 1 },
            }
            yield* s.tasks.update(record.spec.id, { state: "done", verdict }).pipe(Effect.orDie)
            return { verdict, stopped: false }
          }),
      })
      const result = yield* h.flow.run(h.root.id)
      expect(result.verdict.kind).toBe("ok")
      expect(result.verdict.evidence).toEqual([PR])
      expect(result.verdict.cost.usd).toBe(1.5)
      expect(result.recorded).toBe(true)
      expect(peak).toBe(2)
      expect(h.integration.merges).toHaveLength(3)
      expect(h.integration.prs).toHaveLength(1)
      expect((yield* s.tasks.get(h.root.id)).state).toBe("done")
      expect(yield* podStates(s, h.root.id)).toEqual(["closed"])
      expect(yield* stateOrder(h.root.id)).toEqual([
        "state:running",
        "pod.opened",
        "pod.closed",
        "state:done",
      ])
    }).pipe(Effect.provide(PodLayer)),
  )

  it.effect("frees the Bot of the root when the plan ends, even with steps in that same Bot", () =>
    Effect.gen(function* () {
      const s = yield* setupPods(["Instruções."])
      const h = yield* harness(s, { rootBot: "worker" })
      yield* s.bots.setState(s.worker.id, "working", h.root.id)
      yield* h.flow.run(h.root.id)
      expect((yield* s.bots.list()).find((bot) => bot.id === s.worker.id)?.state).toBe("idle")
    }).pipe(Effect.provide(PodLayer)),
  )

  it.effect("runs an ordinary task, a plan step and a skipped plan the ordinary way", () =>
    Effect.gen(function* () {
      const s = yield* setupPods(["x"])
      const simple = yield* harness(s, {
        signals: {},
        rootOver: { kind: "research", repo: undefined, acceptance: ["one"] },
      })
      yield* simple.flow.run(simple.root.id)
      expect(simple.ordinary).toEqual([simple.root.id])
      expect(yield* podStates(s, simple.root.id)).toEqual([])
      // A step task (parent.planId) is never planned, whatever its size.
      const stepRoot = yield* harness(s, {
        rootOver: {
          parent: { planId: simple.plan.id, stepId: newStepId() },
        },
      })
      yield* stepRoot.flow.run(stepRoot.root.id)
      expect(stepRoot.ordinary).toEqual([stepRoot.root.id])
      const skipped = yield* harness(s, {
        planner: () => Effect.succeed({ kind: "skipped", reason: "trigger" }),
      })
      yield* skipped.flow.run(skipped.root.id)
      expect(skipped.ordinary).toEqual([skipped.root.id])
    }).pipe(Effect.provide(PodLayer)),
  )

  it.effect("returns the planner's verdict when the plan is blocked, without opening a Pod", () =>
    Effect.gen(function* () {
      const s = yield* setupPods(["x"])
      const verdict = {
        kind: "blocked" as const,
        summary: "no valid plan",
        evidence: ["invalid plan"],
        cost: { tokensIn: 0, tokensOut: 0, usd: 0, seconds: 0 },
      }
      const h = yield* harness(s, { planner: () => Effect.succeed({ kind: "blocked", verdict }) })
      const result = yield* h.flow.run(h.root.id)
      expect(result).toEqual({ verdict, recorded: true, stopped: false })
      expect(yield* podStates(s, h.root.id)).toEqual([])
      expect(h.ordinary).toEqual([])
    }).pipe(Effect.provide(PodLayer)),
  )

  it.effect("closes the Pod and fails the root when the dispatcher fails", () =>
    Effect.gen(function* () {
      const s = yield* setupPods(["Instruções."])
      const h = yield* harness(s, {
        open: Effect.fail(new IntegrationFailed({ op: "open", cause: "no clone" })),
      })
      const result = yield* h.flow.run(h.root.id)
      expect(result.verdict.summary).toContain("plan flow failed: IntegrationFailed")
      expect(result.recorded).toBe(true)
      expect((yield* s.tasks.get(h.root.id)).state).toBe("failed")
      expect(yield* podStates(s, h.root.id)).toEqual(["closed"])
    }).pipe(Effect.provide(PodLayer)),
  )

  it.effect("cancels the open steps and closes the Pod when the root is stopped", () =>
    Effect.gen(function* () {
      const s = yield* setupPods(["Instruções."])
      const started = yield* Deferred.make<void>()
      let created = 0
      const h = yield* harness(s, {
        runStep: (record) =>
          Effect.gen(function* () {
            yield* s.tasks.update(record.spec.id, { state: "running" }).pipe(Effect.orDie)
            created += 1
            if (created === 2) yield* Deferred.succeed(started, undefined)
            return yield* Effect.never
          }),
      })
      const fiber = yield* Effect.forkChild(h.flow.run(h.root.id))
      yield* Deferred.await(started)
      yield* Deferred.succeed(h.stop, "renan")
      const result = yield* Fiber.join(fiber)
      expect(result.stopped).toBe(true)
      expect((yield* s.tasks.get(h.root.id)).state).toBe("cancelled")
      const records = yield* Effect.forEach([s.worker.id], (id) => s.tasks.listByBot(id)).pipe(
        Effect.map((all) => all.flat()),
      )
      const steps = records.filter((record) => record.spec.parent !== undefined)
      expect(steps).toHaveLength(2)
      expect(steps.map((record) => record.state)).toEqual(["cancelled", "cancelled"])
      expect(yield* podStates(s, h.root.id)).toEqual(["closed"])
    }).pipe(Effect.provide(PodLayer)),
  )

  it.effect("closes the Pod when the run is interrupted", () =>
    Effect.gen(function* () {
      const s = yield* setupPods(["Instruções."])
      const started = yield* Deferred.make<void>()
      const h = yield* harness(s, {
        runStep: (record) =>
          Effect.gen(function* () {
            yield* s.tasks.update(record.spec.id, { state: "running" }).pipe(Effect.orDie)
            yield* Deferred.succeed(started, undefined)
            return yield* Effect.never
          }),
      })
      const fiber = yield* Effect.forkChild(h.flow.run(h.root.id))
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      expect(yield* podStates(s, h.root.id)).toEqual(["closed"])
    }).pipe(Effect.provide(PodLayer)),
  )

  it.effect("a stop while the plan is drafted cancels the root and runs nothing", () =>
    Effect.gen(function* () {
      const s = yield* setupPods(["x"])
      const started = yield* Deferred.make<void>()
      const h = yield* harness(s, {
        planner: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      })
      const fiber = yield* Effect.forkChild(h.flow.run(h.root.id))
      yield* Deferred.await(started)
      yield* Deferred.succeed(h.stop, "renan")
      const result = yield* Fiber.join(fiber)
      expect(result.stopped).toBe(true)
      expect((yield* s.tasks.get(h.root.id)).state).toBe("cancelled")
      expect(yield* podStates(s, h.root.id)).toEqual([])
    }).pipe(Effect.provide(PodLayer)),
  )

  it.effect("does not dispatch a plan over a task that is no longer ready", () =>
    Effect.gen(function* () {
      const s = yield* setupPods(["x"])
      const h = yield* harness(s, {
        planner: (root, plan) =>
          s.tasks
            .update(root.id, { state: "cancelled" })
            .pipe(Effect.orDie, Effect.as({ kind: "planned" as const, plan, warnings: [] })),
      })
      const result = yield* h.flow.run(h.root.id)
      expect(result.recorded).toBe(true)
      expect((yield* s.tasks.get(h.root.id)).state).toBe("cancelled")
      expect(yield* podStates(s, h.root.id)).toEqual([])
    }).pipe(Effect.provide(PodLayer)),
  )

  it.effect("does not run a root with a stored plan as an ordinary task after a restart", () =>
    Effect.gen(function* () {
      const s = yield* setupPods(["Instruções."])
      const h = yield* harness(s)
      yield* h.store
      yield* s.pods.open(h.plan)
      yield* s.tasks.update(h.root.id, { state: "running" })
      const result = yield* h.flow.run(h.root.id)
      expect(h.ordinary).toEqual([])
      expect(result.verdict.summary).toBe(PLAN_RESTART_REASON)
      expect((yield* s.tasks.get(h.root.id)).state).toBe("failed")
      expect(yield* podStates(s, h.root.id)).toEqual(["closed"])
      const beacon = yield* Beacon
      const raised = Array.from(yield* Stream.runCollect(beacon.readAll(0, ["error.raised"])))
      expect(raised.some((event) => JSON.stringify(event.payload).includes("PlanRestarted"))).toBe(true)
    }).pipe(Effect.provide(PodLayer)),
  )
})
