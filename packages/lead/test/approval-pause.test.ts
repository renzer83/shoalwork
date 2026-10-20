import { it } from "@effect/vitest"
import type { ExecutorTask } from "@shoalwork/contracts"
import { Approvals } from "@shoalwork/policy"
import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { describe, expect } from "vitest"
import { ApprovalFlow, Control } from "../src/index.js"
import {
  ASK,
  approvalLayer,
  askFirst,
  DONE,
  jobsOf,
  STARTED,
  scripted,
  TWO_HOURS,
} from "./approval-support.js"
import { allEvents, createBot, Lead, specFor, USAGE_EVENT } from "./support.js"

describe("approval pauses", () => {
  it.effect("a late click expires the request and closes the task before the watchdog ticks", () => {
    const runs: Array<ExecutorTask> = []
    return Effect.gen(function* () {
      const { lead, spec, pending } = yield* askFirst(runs)
      const flow = yield* ApprovalFlow
      yield* TestClock.adjust(TWO_HOURS + 1)
      const result = yield* flow.decide(pending.id, "approved", "user:telegram:1")
      expect(result).toMatchObject({ _tag: "AlreadyResolved", approval: { status: "expired" } })
      const record = yield* lead.get(spec.id)
      expect(record.state).toBe("failed")
      expect(record.verdict).toMatchObject({ kind: "blocked" })
      expect(yield* jobsOf(spec.id)).toBe(1)
      // The sweep that comes later finds nothing left to do.
      expect(yield* flow.expireDue()).toBe(0)
    }).pipe(Effect.provide(approvalLayer(scripted([[STARTED, ASK]], runs))))
  })

  it.effect("a decision already used does not resume a later pause that has no request", () => {
    const runs: Array<ExecutorTask> = []
    return Effect.gen(function* () {
      const { lead, spec, pending } = yield* askFirst(runs)
      const flow = yield* ApprovalFlow
      yield* flow.decide(pending.id, "approved", "user:web")
      // The resumed run pauses again (pause B).
      yield* lead.runOnce(spec.id)
      expect(runs).toHaveLength(2)
      const approvals = yield* Approvals
      const second = yield* approvals.listPending()
      expect(second).toHaveLength(1)
      expect(second[0]?.id).not.toBe(pending.id)
      // The request of B is lost (crash): only the old, used approval A is left for the task.
      const sql = yield* SqlClient
      yield* sql`DELETE FROM approvals WHERE status = 'pending'`
      expect((yield* lead.get(spec.id)).state).toBe("waiting_approval")
      yield* lead.runOnce(spec.id)
      expect(runs).toHaveLength(2)
      expect((yield* lead.get(spec.id)).state).toBe("waiting_approval")
    }).pipe(
      Effect.provide(
        approvalLayer(
          scripted(
            [
              [STARTED, ASK],
              [STARTED, ASK],
            ],
            runs,
          ),
        ),
      ),
    )
  })

  it.effect("the pause and its request are stored together: no request, no waiting_approval", () => {
    const runs: Array<ExecutorTask> = []
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot, { kind: "chat" }))
      const sql = yield* SqlClient
      yield* sql`DROP TABLE approvals`
      const verdict = yield* lead.runOnce(spec.id)
      expect(verdict.kind).not.toBe("ok")
      expect((yield* lead.get(spec.id)).state).not.toBe("waiting_approval")
    }).pipe(Effect.provide(approvalLayer(scripted([[STARTED, ASK]], runs))))
  })

  it.effect("the resume carries the input as data and the usage so far", () => {
    const runs: Array<ExecutorTask> = []
    return Effect.gen(function* () {
      const { lead, spec, pending } = yield* askFirst(runs)
      const flow = yield* ApprovalFlow
      yield* flow.decide(pending.id, "denied", "user:cli")
      const verdict = yield* lead.runOnce(spec.id)
      expect(runs[1]?.prompt).toContain('<<<\n{"command":"rm -rf build"}\n>>>')
      // 0.25 per run: the budget of the task counts the run before the pause.
      expect(verdict.cost.usd).toBeCloseTo(0.5)
    }).pipe(
      Effect.provide(
        approvalLayer(
          scripted(
            [
              [STARTED, USAGE_EVENT, ASK],
              [STARTED, USAGE_EVENT, DONE],
            ],
            runs,
          ),
        ),
      ),
    )
  })

  it.effect("stopping a task that waits ends its pending request with an event", () => {
    const runs: Array<ExecutorTask> = []
    return Effect.gen(function* () {
      const { spec, pending } = yield* askFirst(runs)
      const control = yield* Control
      yield* control.stop({ _tag: "Task", taskId: spec.id }, "user:test")
      const approvals = yield* Approvals
      expect(yield* approvals.get(pending.id)).toMatchObject({ status: "expired", resolvedBy: "system:stop" })
      expect((yield* allEvents).filter((event) => event.type === "approval.resolved")).toMatchObject([
        { payload: { approvalId: pending.id, decision: "expired", by: "system:stop" } },
      ])
      const flow = yield* ApprovalFlow
      expect((yield* flow.decide(pending.id, "approved", "user:web"))._tag).toBe("AlreadyResolved")
      expect(yield* jobsOf(spec.id)).toBe(1)
    }).pipe(Effect.provide(approvalLayer(scripted([[STARTED, ASK]], runs))))
  })
})
