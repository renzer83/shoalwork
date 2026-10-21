import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Beacon, BeaconLive } from "@shoalwork/beacon"
import { BotRegistry, BotRegistryLive } from "@shoalwork/bots"
import { type Bot, NewBot, type NewEvent, streamIds, TimelinePage } from "@shoalwork/contracts"
import { GhClientTest } from "@shoalwork/currents"
import { withTempDb } from "@shoalwork/db/testing"
import { makeRegistry } from "@shoalwork/executors"
import { ApprovalFlowLive, Lead, LeadLive, McpTokensLive, TaskStore, TaskStoreLive } from "@shoalwork/lead"
import { Approvals, ApprovalsLive } from "@shoalwork/policy"
import { TankLocalLive } from "@shoalwork/tank"
import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect"
import { makeApp } from "../src/http/app.js"
import type { RunEffect } from "../src/http/routes/respond.js"
import { DEFAULT_TIERS } from "../src/model-tiers.js"

export const TOKEN = "test-token"
export const AUTH = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }

const tankRoot = mkdtempSync(join(tmpdir(), "shoalwork-messages-tank-"))
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

export const runtime = ManagedRuntime.make(TestLayer)
export const runEffect: RunEffect = <A, E>(eff: Effect.Effect<A, E, Layer.Success<typeof TestLayer>>) =>
  runtime.runPromise(eff)
export const app = makeApp({ apiToken: Redacted.make(TOKEN), runEffect })

export const newBot = (name: string) =>
  Schema.decodeUnknownSync(NewBot)({
    name,
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

export let bot: Bot
export let other: Bot
export const prepare = async () => {
  bot = await runEffect(
    Effect.flatMap(BotRegistry, (registry) => registry.upsert(newBot("chat-bot"), "test")),
  )
  other = await runEffect(
    Effect.flatMap(BotRegistry, (registry) => registry.upsert(newBot("other-bot"), "test")),
  )
}
export const cleanup = async () => {
  await runtime.dispose()
  rmSync(tankRoot, { recursive: true, force: true })
}

export const append = (event: NewEvent) =>
  runEffect(Effect.flatMap(Beacon, (beacon) => beacon.append(event)).pipe(Effect.orDie))

export const message = (
  type: "message.inbound" | "message.outbound",
  forBot: Bot,
  text: string,
): NewEvent => ({
  streamId: streamIds.bot(forBot.id),
  type,
  payload:
    type === "message.inbound"
      ? { channel: "app", userId: "user:app", text, botId: forBot.id }
      : { channel: "telegram", botId: forBot.id, text },
  actor: type === "message.inbound" ? "user:app" : `bot:${forBot.id}`,
  correlationId: "corr_messages_test",
})

export const get = (query: string) => app.request(`/messages?${query}`, { headers: AUTH })
export const page = async (query: string) =>
  Schema.decodeUnknownSync(TimelinePage)(await (await get(query)).json())

export const waitingTask = (forBot: Bot) =>
  runEffect(
    Effect.gen(function* () {
      const lead = yield* Lead
      const spec = yield* lead.intake({
        botId: forBot.id,
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
        botId: forBot.id,
        action: { tool: "Bash", input: "rm -rf build", resource: "build/" },
        risk: "irreversible",
      })
      return { taskId: spec.id, approvalId: approval.id }
    }),
  )

// Twelve events of the Bot's conversation in a fresh Bot, plus noise that must not show up.
export const fixture = async () => {
  const mine = await runEffect(
    Effect.flatMap(BotRegistry, (registry) =>
      registry.upsert(newBot(`fx-${crypto.randomUUID().slice(0, 8)}`), "test"),
    ),
  )
  const { taskId, approvalId } = await waitingTask(mine)
  await app.request(`/approvals/${approvalId}`, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ decision: "approved", via: "web" }),
  })
  const runEvent = (event: unknown): NewEvent => ({
    streamId: streamIds.task(taskId),
    type: "executor.event",
    payload: { taskId, botId: mine.id, event },
    actor: `bot:${mine.id}`,
    correlationId: "corr_fixture",
  })
  await append(message("message.inbound", mine, "fixture one"))
  await append(message("message.outbound", mine, "fixture two"))
  await append({
    streamId: streamIds.task(taskId),
    type: "task.state_changed",
    payload: { taskId, from: "ready", to: "running", reason: "fixture-running" },
    actor: "system:lead",
    correlationId: "corr_fixture",
  })
  await append(runEvent({ kind: "command", cmd: "pnpm test", exitCode: 0 }))
  await append(runEvent({ kind: "file_edit", path: "src/a.ts" }))
  await append(runEvent({ kind: "text", text: "thinking out loud" }))
  await append(
    runEvent({ kind: "done", result: "ok", artifacts: [{ kind: "pr", ref: "https://example.test/pr/1" }] }),
  )
  await append({
    streamId: streamIds.task(taskId),
    type: "executor.finished",
    payload: {
      taskId,
      botId: mine.id,
      verdict: {
        kind: "ok",
        summary: "fixture done",
        evidence: [],
        cost: { tokensIn: 1, tokensOut: 1, usd: 0, seconds: 1 },
      },
      durationMs: 10,
    },
    actor: `bot:${mine.id}`,
    correlationId: "corr_fixture",
  })
  await append(message("message.inbound", other, "someone else"))
  await append(message("message.inbound", mine, "fixture three"))
  return { mine, taskId, approvalId }
}
