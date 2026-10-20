import { it } from "@effect/vitest"
import { BeaconTest } from "@shoalwork/beacon"
import { BotId, newTaskId } from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { Approvals, ApprovalsLive, makePolicyTest, Policy, UNRESOLVED_POLICY } from "../src/index.js"

const BOT = Schema.decodeUnknownSync(BotId)("bot_3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41")
const BASE = `rules:\n  - { bot: "*", tool: "Read(.env*)", effect: deny, reason: "local secrets" }\n`
const STRICT = `${BASE}  - { bot: "*", tool: "Grep", effect: deny, reason: "strict only" }\n`
const GREP = { tool: "Grep", input: { pattern: "x" } }

const policyLayer = (named: string | Effect.Effect<string | undefined>) =>
  makePolicyTest({ sources: { default: BASE, strict: STRICT }, policyOf: () => named }).pipe(
    Layer.provideMerge(ApprovalsLive),
    Layer.provideMerge(BeaconTest),
    Layer.provideMerge(withTempDb()),
  )

describe("policyOf may look the Bot up", () => {
  it.effect("an Effect that names a policy picks its rules", () =>
    Effect.gen(function* () {
      const policy = yield* Policy
      expect((yield* policy.evaluate(BOT, GREP)).effect).toBe("deny")
    }).pipe(Effect.provide(policyLayer(Effect.succeed("strict")))),
  )

  it.effect("an Effect that names nothing takes the default policy", () =>
    Effect.gen(function* () {
      const policy = yield* Policy
      expect((yield* policy.evaluate(BOT, GREP)).effect).toBe("allow")
    }).pipe(Effect.provide(policyLayer(Effect.succeed(undefined)))),
  )

  it.effect("a Bot that could not be read asks for every call (fail-closed)", () =>
    Effect.gen(function* () {
      const policy = yield* Policy
      expect((yield* policy.evaluate(BOT, GREP)).effect).toBe("ask")
    }).pipe(Effect.provide(policyLayer(Effect.succeed(UNRESOLVED_POLICY)))),
  )
})

const newTask = Effect.gen(function* () {
  const sql = yield* SqlClient
  const taskId = newTaskId()
  const now = new Date(0).toISOString()
  yield* sql`INSERT OR IGNORE INTO bots (id, name, definition, state, updated_at)
    VALUES (${BOT}, 'modes', '{}', 'idle', ${now})`
  yield* sql`INSERT INTO tasks (id, bot_id, spec, state, created_at, updated_at)
    VALUES (${taskId}, ${BOT}, '{}', 'running', ${now}, ${now})`
  return taskId
})

describe("approval mode", () => {
  it.effect("is resume unless the request says inline", () =>
    Effect.gen(function* () {
      const approvals = yield* Approvals
      const action = { tool: "Bash", input: { command: "git push" } }
      const resume = yield* approvals.request({
        taskId: yield* newTask,
        botId: BOT,
        action,
        risk: "external",
      })
      const inline = yield* approvals.request({
        taskId: yield* newTask,
        botId: BOT,
        action,
        risk: "external",
        mode: "inline",
      })
      expect(resume.mode).toBe("resume")
      expect(inline.mode).toBe("inline")
      expect((yield* approvals.get(inline.id)).mode).toBe("inline")
    }).pipe(Effect.provide(policyLayer("default"))),
  )
})
