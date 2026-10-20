import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BeaconLive } from "@shoalwork/beacon"
import { BotRegistry, BotRegistryLive } from "@shoalwork/bots"
import { type Bot, NewBot, type TaskId } from "@shoalwork/contracts"
import { GhClientTest } from "@shoalwork/currents"
import { withTempDb } from "@shoalwork/db/testing"
import { makeRegistry } from "@shoalwork/executors"
import { ApprovalFlowLive, Lead, LeadLive, McpTokensLive, TaskStore, TaskStoreLive } from "@shoalwork/lead"
import { Approvals, ApprovalsLive } from "@shoalwork/policy"
import { TankLocalLive } from "@shoalwork/tank"
import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { makeApp } from "../src/http/app.js"
import type { RunEffect } from "../src/http/routes/respond.js"
import { DEFAULT_TIERS } from "../src/model-tiers.js"
import { runWatchdogCycle } from "../src/watchdog.js"

const TOKEN = "test-token"
const AUTH = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }

const tankRoot = mkdtempSync(join(tmpdir(), "shoalwork-approvals-tank-"))
// The production wiring of the approval pieces: store, Lead (which records the request) and the flow, minus the worker.
const base = Layer.provideMerge(BeaconLive, withTempDb())
const store = Layer.provideMerge(
  Layer.mergeAll(TaskStoreLive, McpTokensLive),
  Layer.provideMerge(
    Layer.mergeAll(
      BotRegistryLive,
      TankLocalLive({ root: tankRoot, baseEnv: {} }),
      makeRegistry([]),
      GhClientTest().layer,
    ),
    base,
  ),
)
const TestLayer = LeadLive(DEFAULT_TIERS).pipe(
  Layer.provideMerge(ApprovalFlowLive),
  Layer.provideMerge(ApprovalsLive),
  Layer.provideMerge(store),
)

const runtime = ManagedRuntime.make(TestLayer)
const runEffect: RunEffect = <A, E>(eff: Effect.Effect<A, E, Layer.Success<typeof TestLayer>>) =>
  runtime.runPromise(eff)
const app = makeApp({ apiToken: Redacted.make(TOKEN), runEffect })

const NEW_BOT = Schema.decodeUnknownSync(NewBot)({
  name: "approvals-bot",
  role: "developer",
  kind: "auxiliary",
  instructions: "Answer briefly.",
  executors: { preferred: "claude-code", allowed: ["claude-code"] },
  modelTiers: {},
  connectors: [],
  budget: { tokens: 200000, seconds: 1800, usd: 2 },
  policy: "default",
  tank: { mode: "local", host: "mac" },
  memory: { scope: "bot" },
})

let bot: Bot
beforeAll(async () => {
  bot = await runEffect(Effect.flatMap(BotRegistry, (registry) => registry.upsert(NEW_BOT, "test")))
})
afterAll(async () => {
  await runtime.dispose()
  rmSync(tankRoot, { recursive: true, force: true })
})

// A task that stopped to ask, with its pending approval.
const waitingTask = (ttlMs?: number) =>
  runEffect(
    Effect.gen(function* () {
      const lead = yield* Lead
      const spec = yield* lead.intake({
        botId: bot.id,
        title: "ask",
        prompt: "do it",
        kind: "chat",
        acceptance: [],
        budget: { tokens: 1000, seconds: 1800, usd: 1 },
        origin: "api",
      })
      yield* (yield* TaskStore).update(spec.id, { state: "waiting_approval" })
      const approvals = yield* Approvals
      const approval = yield* approvals.request({
        taskId: spec.id,
        botId: bot.id,
        action: { tool: "Bash", input: "rm -rf build", resource: "build/" },
        risk: "irreversible",
        ttlMs,
      })
      return { taskId: spec.id as TaskId, approvalId: approval.id }
    }),
  )

const decide = (id: string, body: unknown) =>
  app.request(`/approvals/${id}`, { method: "POST", headers: AUTH, body: JSON.stringify(body) })

interface ListBody {
  readonly approvals: ReadonlyArray<{ readonly id: string; readonly status: string }>
}

describe("approval routes", () => {
  it("requires the API token", async () => {
    expect((await app.request("/approvals")).status).toBe(401)
    expect((await app.request("/approvals/apr_x", { method: "POST" })).status).toBe(401)
  })

  it("lists pending approvals and rejects an unknown status", async () => {
    const { approvalId } = await waitingTask()
    const res = await app.request("/approvals?status=pending", { headers: AUTH })
    expect(res.status).toBe(200)
    const body = (await res.json()) as ListBody
    expect(body.approvals.map((entry) => entry.id)).toContain(approvalId)
    expect((await app.request("/approvals?status=bogus", { headers: AUTH })).status).toBe(400)
  })

  it("decides once; the second decision only reports what was decided", async () => {
    const { approvalId } = await waitingTask()
    const first = await decide(approvalId, { decision: "approved", via: "web" })
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({ result: "resolved", approval: { status: "approved" } })
    const second = await decide(approvalId, { decision: "denied", via: "cli" })
    expect(await second.json()).toMatchObject({ result: "already", approval: { status: "approved" } })
    const pending = (await (
      await app.request("/approvals?status=pending", { headers: AUTH })
    ).json()) as ListBody
    expect(pending.approvals.map((entry) => entry.id)).not.toContain(approvalId)
  })

  it("answers 400 to a bad body and 404 to an unknown or malformed id", async () => {
    const { approvalId } = await waitingTask()
    expect((await decide(approvalId, { decision: "maybe" })).status).toBe(400)
    expect((await decide("apr_00000000-0000-4000-8000-000000000000", { decision: "approved" })).status).toBe(
      404,
    )
    expect((await decide("not-an-id", { decision: "approved" })).status).toBe(404)
  })
})

describe("watchdog expiry", () => {
  it("expires a due approval and closes the waiting task as blocked", async () => {
    const { taskId, approvalId } = await waitingTask(0)
    await runEffect(runWatchdogCycle({ intervalMs: 300_000, staleMinutes: 20, maxProcessMinutes: 45 }))
    const view = await runEffect(Effect.flatMap(Lead, (lead) => lead.get(taskId)))
    expect(view.state).toBe("failed")
    expect(view.verdict).toMatchObject({ kind: "blocked" })
    const approval = await runEffect(Effect.flatMap(Approvals, (approvals) => approvals.get(approvalId)))
    expect(approval.status).toBe("expired")
  })
})
