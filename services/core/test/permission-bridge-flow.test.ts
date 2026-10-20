import { readFileSync } from "node:fs"
import { BeaconLive } from "@shoalwork/beacon"
import { BotRegistry, BotRegistryLive } from "@shoalwork/bots"
import { ApprovalId, NewBot } from "@shoalwork/contracts"
import { GhClientTest } from "@shoalwork/currents"
import { withTempDb } from "@shoalwork/db/testing"
import { makeRegistry } from "@shoalwork/executors"
import {
  ApprovalFlow,
  ApprovalFlowLive,
  Lead,
  LeadLive,
  McpTokens,
  McpTokensLive,
  TaskStoreLive,
} from "@shoalwork/lead"
import { Approvals, ApprovalsLive, makePolicyTest, type Policy } from "@shoalwork/policy"
import { TankLocalLive } from "@shoalwork/tank"
import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { afterAll, describe, expect, it } from "vitest"
import { makeApp } from "../src/http/app.js"
import { DEFAULT_TIERS } from "../src/model-tiers.js"

const DEFAULT_YAML = readFileSync(new URL("../../../config/policies/default.yaml", import.meta.url), "utf8")
const NEW_BOT = Schema.decodeUnknownSync(NewBot)({
  name: "flow-bot",
  role: "developer",
  kind: "auxiliary",
  instructions: "Do nothing.",
  executors: { preferred: "claude-code", allowed: ["claude-code"] },
  modelTiers: {},
  connectors: [],
  budget: { tokens: 200000, seconds: 1800, usd: 2 },
  policy: "default",
  tank: { mode: "local", host: "mac" },
  memory: { scope: "bot" },
})

// The production wiring of the route: the real ApprovalFlow, task store and Lead are in the context.
const base = Layer.mergeAll(
  BotRegistryLive,
  TankLocalLive({ root: "/tmp/shoalwork-flow-unused", baseEnv: {} }),
  makeRegistry([]),
  GhClientTest().layer,
).pipe(Layer.provideMerge(Layer.provideMerge(BeaconLive, withTempDb())))
const layer = makePolicyTest({ sources: { default: DEFAULT_YAML }, policyOf: () => "default" }).pipe(
  Layer.provideMerge(ApprovalFlowLive),
  Layer.provideMerge(LeadLive(DEFAULT_TIERS)),
  Layer.provideMerge(ApprovalsLive),
  Layer.provideMerge(McpTokensLive),
  Layer.provideMerge(TaskStoreLive),
  Layer.provideMerge(base),
)
const runtime = ManagedRuntime.make(layer)
afterAll(() => runtime.dispose())
const run = <A, E>(
  eff: Effect.Effect<A, E, Lead | McpTokens | Policy | Approvals | ApprovalFlow | SqlClient | BotRegistry>,
) => runtime.runPromise(eff)
const runSql = <A, E>(eff: Effect.Effect<A, E, SqlClient>): Promise<A> => runtime.runPromise(eff)
const runTokens = <A, E>(eff: Effect.Effect<A, E, McpTokens | SqlClient>): Promise<A> =>
  runtime.runPromise(eff)
const runPolicy = <A, E>(eff: Effect.Effect<A, E, Policy | Approvals>): Promise<A> => runtime.runPromise(eff)
const app = makeApp({ apiToken: Redacted.make("t"), runEffect: runSql, runMcp: runTokens, runPolicy })

const Answer = Schema.Struct({ effect: Schema.String, approvalId: Schema.optional(Schema.String) })

describe("POST /policy/evaluate with the approval flow in the context", () => {
  it("an ask pauses the task, the decision gives it back, and the ticket is spent once", async () => {
    const started = await run(
      Effect.gen(function* () {
        const bot = yield* (yield* BotRegistry).upsert(NEW_BOT, "test")
        const spec = yield* (yield* Lead).intake({
          botId: bot.id,
          title: "flow",
          prompt: "wait",
          kind: "chat",
          acceptance: [],
          budget: { tokens: 1000, seconds: 1800, usd: 1 },
          tier: "chat",
          origin: "api",
        })
        const sql = yield* SqlClient
        yield* sql`UPDATE tasks SET state = 'running' WHERE id = ${spec.id}`
        const issued = yield* (yield* McpTokens).issue({
          botId: bot.id,
          repo: "shoalwork",
          taskId: spec.id,
          ttl: 3_600_000,
          bridgeMode: "inline",
        })
        return { spec, token: Redacted.value(issued.token) }
      }),
    )
    const call = { tool: "Bash", input: { command: "git push origin main" } }
    const evaluate = async () => {
      const response = await app.request("/policy/evaluate", {
        method: "POST",
        headers: { authorization: `Bearer ${started.token}`, "content-type": "application/json" },
        body: JSON.stringify(call),
      })
      return Schema.decodeUnknownSync(Answer)(await response.json())
    }
    const asked = await evaluate()
    expect(asked.effect).toBe("ask")
    const stateNow = async () =>
      (
        await runSql(
          Effect.flatMap(SqlClient, (sql) => sql`SELECT state FROM tasks WHERE id = ${started.spec.id}`),
        )
      )[0]?.state
    expect(await stateNow()).toBe("waiting_approval")
    await run(
      Effect.gen(function* () {
        const approvals = yield* Approvals
        const record = yield* approvals.get(Schema.decodeUnknownSync(ApprovalId)(asked.approvalId))
        expect(record.mode).toBe("inline")
        yield* (yield* ApprovalFlow).decide(record.id, "approved", "user:web")
      }),
    )
    expect(await stateNow()).toBe("running")
    expect(await evaluate()).toEqual({ effect: "allow", approvalId: asked.approvalId })
  })
})
