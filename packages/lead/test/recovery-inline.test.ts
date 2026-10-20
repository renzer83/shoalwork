import { it } from "@effect/vitest"
import { Approvals } from "@shoalwork/policy"
import { Effect, Option } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { ApprovalFlow, Control } from "../src/index.js"
import { approvalLayer, DONE, STARTED, scripted } from "./approval-support.js"
import { createBot, Lead, specFor } from "./support.js"

const PUSH = { tool: "Bash", input: { command: "git push" } } as const

// A task the previous process left running, its CLI blocked on an inline request (the job is active).
const orphanWaiting = Effect.gen(function* () {
  const lead = yield* Lead
  const sql = yield* SqlClient
  const bot = yield* createBot
  const spec = yield* lead.intake(specFor(bot, { kind: "chat" }))
  yield* sql`UPDATE tasks SET state = 'running', attempts = 1 WHERE id = ${spec.id}`
  yield* sql`UPDATE jobs SET state = 'active', attempts = 1 WHERE json_extract(payload, '$.taskId') = ${spec.id}`
  const flow = yield* ApprovalFlow
  const asked = yield* flow.requestInline({ taskId: spec.id, botId: bot.id, action: PUSH, risk: "external" })
  return { lead, spec, asked }
})

const jobState = (taskId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const rows = yield* sql`SELECT state FROM jobs WHERE json_extract(payload, '$.taskId') = ${taskId}`
    return rows.map((row) => row.state)
  })

const layer = approvalLayer(scripted([[STARTED, DONE]], []))

describe("recoverOrphans with an inline approval", () => {
  it.effect("a pending request is expired by the restart and the task is resumed like a running one", () =>
    Effect.gen(function* () {
      const { lead, spec, asked } = yield* orphanWaiting
      expect((yield* lead.get(spec.id)).state).toBe("waiting_approval")
      const report = yield* (yield* Control).recoverOrphans()
      expect(report).toEqual({ resumed: [spec.id], failed: [] })
      expect(yield* (yield* Approvals).get(asked.id)).toMatchObject({
        status: "expired",
        resolvedBy: "system:restart",
      })
      expect((yield* lead.get(spec.id)).state).toBe("running")
      expect(yield* jobState(spec.id)).toEqual(["queued"])
    }).pipe(Effect.provide(layer)),
  )

  // Decision: a ticket approved but not yet spent survives the restart. It is tied to the exact call (hash) and is
  // spent once, so the resumed session that asks again gets the allow without a second question.
  it.effect("an approved ticket not yet spent is kept and spent once by the call that asks again", () =>
    Effect.gen(function* () {
      const { spec, asked } = yield* orphanWaiting
      yield* (yield* ApprovalFlow).decide(asked.id, "approved", "user:web")
      yield* (yield* Control).recoverOrphans()
      const approvals = yield* Approvals
      expect((yield* approvals.get(asked.id)).consumedAt).toBeUndefined()
      const used = yield* approvals.consumeMatching(spec.id, PUSH)
      expect(Option.isSome(used) && used.value.id === asked.id).toBe(true)
      expect(Option.isNone(yield* approvals.consumeMatching(spec.id, PUSH))).toBe(true)
    }).pipe(Effect.provide(layer)),
  )
})
