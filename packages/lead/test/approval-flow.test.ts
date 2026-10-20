import { it } from "@effect/vitest"
import type { ExecutorTask } from "@shoalwork/contracts"
import { Approvals } from "@shoalwork/policy"
import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { describe, expect } from "vitest"
import { ApprovalFlow, type ApprovalFlowShape } from "../src/index.js"
import {
  ASK,
  approvalLayer,
  askFirst,
  DONE,
  edit,
  editedPaths,
  jobsOf,
  STARTED,
  scripted,
  TWO_HOURS,
} from "./approval-support.js"
import { allEvents, createBot, Lead, SESSION, specFor } from "./support.js"

describe("approval flow", () => {
  it.effect("a run that needs approval stores a pending approval, emits it and waits", () => {
    const runs: Array<ExecutorTask> = []
    return Effect.gen(function* () {
      const { lead, spec, verdict, pending } = yield* askFirst(runs)
      expect(verdict.kind).toBe("needs_approval")
      expect((yield* lead.get(spec.id)).state).toBe("waiting_approval")
      expect(pending).toMatchObject({
        taskId: spec.id,
        status: "pending",
        action: { tool: "Bash", resource: "build/" },
        sessionId: SESSION,
      })
      expect(pending.stepId).toBeDefined()
      const types = (yield* allEvents).map((event) => event.type)
      expect(types).toContain("approval.requested")
      // The card only goes out after waiting_approval is stored.
      expect(types.indexOf("approval.requested")).toBeGreaterThan(types.lastIndexOf("task.state_changed") - 1)
      // Pending: delivering the job again changes nothing and does not run the executor.
      yield* lead.runOnce(spec.id)
      expect(runs).toHaveLength(1)
    }).pipe(Effect.provide(approvalLayer(scripted([[STARTED, ASK]], runs))))
  })

  it.effect("approving resumes the same session with APPROVED and does not repeat completed work", () => {
    const runs: Array<ExecutorTask> = []
    return Effect.gen(function* () {
      const { lead, spec, pending } = yield* askFirst(runs)
      const flow = yield* ApprovalFlow
      const decided = yield* flow.decide(pending.id, "approved", "user:web")
      expect(decided._tag).toBe("Resolved")
      expect(yield* jobsOf(spec.id)).toBe(2)
      const verdict = yield* lead.runOnce(spec.id)
      expect(verdict.kind).toBe("ok")
      expect(runs).toHaveLength(2)
      expect(runs[1]?.resumeSessionId).toBe(SESSION)
      expect(runs[1]?.stepId).toBe(runs[0]?.stepId)
      expect(runs[1]?.prompt).toContain("APPROVED: proceed with Bash on build/ exactly as:")
      const paths = editedPaths(yield* allEvents)
      expect(paths).toEqual(["a.ts", "b.ts"])
      expect(new Set(paths).size).toBe(paths.length)
      expect((yield* lead.get(spec.id)).state).toBe("done")
    }).pipe(
      Effect.provide(
        approvalLayer(
          scripted(
            [
              [STARTED, edit("a.ts"), ASK],
              [STARTED, edit("b.ts"), DONE],
            ],
            runs,
          ),
        ),
      ),
    )
  })

  it.effect("denying resumes with DENIED", () => {
    const runs: Array<ExecutorTask> = []
    return Effect.gen(function* () {
      const { lead, spec, pending } = yield* askFirst(runs)
      const flow = yield* ApprovalFlow
      yield* flow.decide(pending.id, "denied", "user:cli")
      yield* lead.runOnce(spec.id)
      expect(runs[1]?.prompt).toContain("DENIED: do not perform Bash on build/ as:")
      expect(runs[1]?.resumeSessionId).toBe(SESSION)
    }).pipe(
      Effect.provide(
        approvalLayer(
          scripted(
            [
              [STARTED, ASK],
              [STARTED, DONE],
            ],
            runs,
          ),
        ),
      ),
    )
  })

  it.effect("two decisions at once (Telegram and web) resolve once and queue one resume", () => {
    const runs: Array<ExecutorTask> = []
    return Effect.gen(function* () {
      const { spec, pending } = yield* askFirst(runs)
      const flow: ApprovalFlowShape = yield* ApprovalFlow
      const id = pending.id
      const results = yield* Effect.all(
        [flow.decide(id, "approved", "user:telegram:1"), flow.decide(id, "denied", "user:web")],
        { concurrency: "unbounded" },
      )
      expect(results.filter((result) => result._tag === "Resolved")).toHaveLength(1)
      expect(results.filter((result) => result._tag === "AlreadyResolved")).toHaveLength(1)
      expect(yield* jobsOf(spec.id)).toBe(2)
      expect((yield* allEvents).filter((event) => event.type === "approval.resolved")).toHaveLength(1)
    }).pipe(Effect.provide(approvalLayer(scripted([[STARTED, ASK]], runs))))
  })

  it.effect("an expired approval denies by default: the task is closed blocked and never resumed", () => {
    const runs: Array<ExecutorTask> = []
    return Effect.gen(function* () {
      const { lead, spec, pending } = yield* askFirst(runs)
      const flow = yield* ApprovalFlow
      expect(yield* flow.expireDue()).toBe(0)
      yield* TestClock.adjust(TWO_HOURS + 1)
      expect(yield* flow.expireDue()).toBe(1)
      const record = yield* lead.get(spec.id)
      expect(record.state).toBe("failed")
      expect(record.verdict).toMatchObject({ kind: "blocked" })
      const events = yield* allEvents
      expect(events.filter((event) => event.type === "approval.resolved")).toMatchObject([
        { payload: { approvalId: pending.id, decision: "expired" } },
      ])
      const late = yield* flow.decide(pending.id, "approved", "user:web")
      expect(late._tag).toBe("AlreadyResolved")
      expect(yield* jobsOf(spec.id)).toBe(1)
      yield* lead.runOnce(spec.id)
      expect(runs).toHaveLength(1)
    }).pipe(Effect.provide(approvalLayer(scripted([[STARTED, ASK]], runs))))
  })

  it.effect("a decision on a task that is no longer waiting ends the request and queues nothing", () => {
    const runs: Array<ExecutorTask> = []
    return Effect.gen(function* () {
      const { lead, spec, pending } = yield* askFirst(runs)
      const sql = yield* SqlClient
      yield* sql`UPDATE tasks SET state = 'cancelled' WHERE id = ${spec.id}`
      const flow = yield* ApprovalFlow
      const result = yield* flow.decide(pending.id, "approved", "user:web")
      expect(result).toMatchObject({ _tag: "AlreadyResolved", approval: { status: "expired" } })
      expect(yield* jobsOf(spec.id)).toBe(1)
      expect((yield* allEvents).filter((event) => event.type === "approval.resolved")).toMatchObject([
        { payload: { decision: "expired" } },
      ])
      yield* lead.runOnce(spec.id)
      expect(runs).toHaveLength(1)
    }).pipe(Effect.provide(approvalLayer(scripted([[STARTED, ASK]], runs))))
  })

  it.effect("a repo task whose worktree is gone resumes on a new step without the old session", () => {
    const runs: Array<ExecutorTask> = []
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(
        specFor(bot, {
          kind: "code",
          repo: { url: "https://github.com/renzer83/shoalwork-sandbox", base: "main" },
        }),
      )
      yield* lead.runOnce(spec.id)
      const approvals = yield* Approvals
      const pending = (yield* approvals.listPending())[0]
      if (pending === undefined) {
        return yield* Effect.die("no pending approval")
      }
      const flow = yield* ApprovalFlow
      yield* flow.decide(pending.id, "approved", "user:web")
      yield* lead.runOnce(spec.id)
      expect(runs).toHaveLength(2)
      expect(runs[1]?.stepId).not.toBe(runs[0]?.stepId)
      expect(runs[1]?.resumeSessionId).toBeUndefined()
      expect(runs[1]?.prompt).toContain("APPROVED: proceed with Bash on build/ exactly as:")
    }).pipe(
      Effect.provide(
        approvalLayer(
          scripted(
            [
              [STARTED, ASK],
              [STARTED, DONE],
            ],
            runs,
          ),
        ),
      ),
    )
  })
})
