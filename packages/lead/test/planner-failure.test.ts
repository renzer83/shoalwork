import { it } from "@effect/vitest"
import { type NewEvent, newTaskId, streamIds } from "@shoalwork/contracts"
import { Effect, Stream } from "effect"
import { describe, expect } from "vitest"
import { fixture, planJson, setup, stepJson, TestLayer } from "./plan-support.js"

// A decision.made as the Reflex writes it for the message that originated the task.
const decisionMade = (correlationId: string, decisionId: string, questionId: string): NewEvent => ({
  streamId: streamIds.system,
  type: "decision.made",
  payload: {
    decisionId,
    questionId,
    kind: "choice",
    value: "code",
    confidence: 0.9,
    source: "rule",
    facts: { text: "build it", channel: "telegram", userId: "42", bots: [], executors: [], hasRepo: false },
  },
  actor: "system:reflex",
  correlationId,
})

describe("Planner.plan failures after the task entered planning", () => {
  it.effect("fails the task when storing the plan breaks half way, leaving no plan and no task.planned", () =>
    Effect.gen(function* () {
      const t = yield* setup(
        [fixture("valid")],
        {},
        {
          wrapStore: (real) => ({
            ...real,
            update: (id, patch) =>
              patch.state === "ready" ? Effect.die("disk gone") : real.update(id, patch),
          }),
        },
      )
      const outcome = yield* t.planner.plan(t.task)
      expect(outcome.kind).toBe("blocked")
      if (outcome.kind !== "blocked") return
      expect(outcome.verdict.summary).toContain("planning failed")
      expect(yield* t.rows()).toHaveLength(0)
      expect((yield* t.tasks.get(t.task.id)).state).toBe("failed")
      const types = (yield* t.events()).map((event) => event.type)
      expect(types).toEqual(["task.state_changed", "task.state_changed"])
      expect(t.script.notes).toHaveLength(1)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("fails the task when the Bot list cannot be read or the ask dies", () =>
    Effect.gen(function* () {
      const listing = yield* setup(
        [fixture("valid")],
        {},
        {
          wrapBots: (real) => ({ ...real, list: () => Effect.die("registry down") }),
        },
      )
      expect((yield* listing.planner.plan(listing.task)).kind).toBe("blocked")
      expect((yield* listing.tasks.get(listing.task.id)).state).toBe("failed")

      const asking = yield* setup([{ die: "boom" }])
      expect((yield* asking.planner.plan(asking.task)).kind).toBe("blocked")
      expect((yield* asking.tasks.get(asking.task.id)).state).toBe("failed")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.live("leaves the task in planning when the planning is interrupted", () =>
    Effect.gen(function* () {
      const t = yield* setup([{ hang: true }])
      const finished = yield* t.planner.plan(t.task).pipe(Effect.timeoutOption("80 millis"))
      expect(finished._tag).toBe("None")
      expect((yield* t.tasks.get(t.task.id)).state).toBe("planning")
      expect(yield* t.rows()).toHaveLength(0)
      // Resumed (state planning), the same task is planned.
      const again = yield* setup([fixture("valid")])
      yield* again.tasks.update(again.task.id, { state: "planning" })
      expect((yield* again.planner.plan(again.task)).kind).toBe("planned")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("records the outcome of the Reflex decisions when the plan is blocked, once", () =>
    Effect.gen(function* () {
      const t = yield* setup([fixture("cyclic"), fixture("cyclic")])
      const other = newTaskId()
      yield* t.beacon.appendMany([
        decisionMade(t.task.id, "d-intent", "intent"),
        decisionMade(t.task.id, "d-owner", "owner"),
        decisionMade(other, "d-other", "intent"),
      ])
      expect((yield* t.planner.plan(t.task)).kind).toBe("blocked")
      const outcomes = Array.from(yield* Stream.runCollect(t.beacon.readAll(0, ["decision.outcome"])))
      expect(outcomes.map((event) => event.payload)).toEqual([
        { decisionId: "d-intent", outcome: "unknown" },
        { decisionId: "d-owner", outcome: "unknown" },
      ])
    }).pipe(Effect.provide(TestLayer)),
  )
})

describe("Planner.plan only plans a task that waits for a plan", () => {
  it.effect.each(["running", "ready", "done", "failed", "cancelled"] as const)(
    "does not touch a task that is %s",
    (state) =>
      Effect.gen(function* () {
        const t = yield* setup([fixture("valid")])
        yield* t.tasks.update(t.task.id, { state })
        expect(yield* t.planner.plan(t.task)).toEqual({ kind: "skipped", reason: "state" })
        expect(t.script.prompts).toHaveLength(0)
        expect((yield* t.tasks.get(t.task.id)).state).toBe(state)
        expect(yield* t.rows()).toHaveLength(0)
        expect(yield* t.events()).toHaveLength(0)
      }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("plans a task once: the second call is skipped and the table holds one plan", () =>
    Effect.gen(function* () {
      const t = yield* setup([planJson([stepJson("a")])])
      expect((yield* t.planner.plan(t.task)).kind).toBe("planned")
      expect(yield* t.planner.plan(t.task)).toEqual({ kind: "skipped", reason: "state" })
      expect(yield* t.rows()).toHaveLength(1)
      expect(t.script.prompts).toHaveLength(1)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("refuses a second plan row for the same task at the database", () =>
    Effect.gen(function* () {
      const t = yield* setup([planJson([stepJson("a")])])
      yield* t.planner.plan(t.task)
      const [row] = yield* t.rows()
      const second = yield* Effect.result(
        t.sql`INSERT INTO plans (id, task_id, plan, state, created_at)
          VALUES ('plan_dup', ${t.task.id}, ${row?.plan ?? ""}, 'ready', '2026-01-01T00:00:00.000Z')`,
      )
      expect(second._tag).toBe("Failure")
    }).pipe(Effect.provide(TestLayer)),
  )
})
