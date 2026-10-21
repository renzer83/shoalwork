import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BeaconLive } from "@shoalwork/beacon"
import { BotRegistry, BotRegistryLive } from "@shoalwork/bots"
import { type Bot, ExecutorId, NewBot, SessionId, TaskId } from "@shoalwork/contracts"
import { GhClientTest } from "@shoalwork/currents"
import { withTempDb } from "@shoalwork/db/testing"
import { type Executor, makeRegistry } from "@shoalwork/executors"
import { Lead, LeadWithStore } from "@shoalwork/lead"
import { TankLocalLive } from "@shoalwork/tank"
import { Effect, Layer, ManagedRuntime, Redacted, Schema, Stream } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { makeApp } from "../src/http/app.js"
import type { RunEffect } from "../src/http/routes/respond.js"
import { DEFAULT_TIERS } from "../src/model-tiers.js"

const TOKEN = "test-token"
const AUTH = { authorization: `Bearer ${TOKEN}` }
const CLAUDE = Schema.decodeUnknownSync(ExecutorId)("claude-code")

interface ReplayStartedBody {
  readonly replay: {
    readonly id: string
    readonly sourceTaskId: string
    readonly taskId: string
    readonly overrides: Record<string, string>
    readonly baseSha: string | null
    readonly contextFrozen: boolean
  }
}
interface ComparisonBody {
  readonly id: string
  readonly sourceTaskId: string
  readonly newTaskId: string
  readonly source: { readonly verdict: { readonly kind: string } | null; readonly executor: string | null }
  readonly replay: { readonly verdict: { readonly kind: string } | null; readonly state: string }
  readonly diff: { readonly verdictChanged: boolean; readonly usdDelta: number }
  readonly notes: ReadonlyArray<string>
}
interface ErrorBody {
  readonly error: string
  readonly entity?: string
  readonly where?: string
}

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T

const executor: Executor = {
  id: CLAUDE,
  run: () =>
    Stream.fromIterable([
      { kind: "started" as const, sessionId: Schema.decodeUnknownSync(SessionId)("sess-1") },
      {
        kind: "usage" as const,
        usage: { tokensIn: 10, tokensOut: 5, cacheRead: 0, cacheWrite: 0, usd: 0.1, seconds: 1 },
      },
      { kind: "done" as const, result: "pong", artifacts: [] },
    ]),
  mapTier: () => ({ model: "fake-model" }),
  quota: () => Effect.succeed({ executor: CLAUDE, usedRatio: 0, available: true }),
}

const tankRoot = mkdtempSync(join(tmpdir(), "shoalwork-replay-tank-"))
const TestLayer = LeadWithStore(DEFAULT_TIERS).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      BotRegistryLive,
      TankLocalLive({ root: tankRoot, baseEnv: {} }),
      makeRegistry([executor]),
      GhClientTest().layer,
    ),
  ),
  Layer.provideMerge(Layer.provideMerge(BeaconLive, withTempDb())),
)

const runtime = ManagedRuntime.make(TestLayer)
const runEffect: RunEffect = <A, E>(eff: Effect.Effect<A, E, Layer.Success<typeof TestLayer>>) =>
  runtime.runPromise(eff)

const app = makeApp({ apiToken: Redacted.make(TOKEN), runEffect })

const NEW_BOT = Schema.decodeUnknownSync(NewBot)({
  name: "replay-bot",
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

const finishedTask = async (): Promise<TaskId> => {
  const res = await app.request("/tasks", {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({
      botId: bot.id,
      title: "Reply",
      prompt: "reply with the single word pong",
      kind: "chat",
      acceptance: [],
      budget: { tokens: 200000, seconds: 1800, usd: 2 },
      tier: "light",
      origin: "cli",
    }),
  })
  const { task } = await json<{ task: { id: string } }>(res)
  const id = Schema.decodeUnknownSync(TaskId)(task.id)
  await runEffect(Effect.flatMap(Lead, (lead) => lead.runOnce(id)))
  return id
}

const post = (id: string, body?: unknown, headers: Record<string, string> = AUTH) =>
  app.request(`/tasks/${id}/replay`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  })

describe("POST /tasks/:id/replay", () => {
  it("starts a new task from a finished one and answers 201 with the link", async () => {
    const id = await finishedTask()

    const res = await post(id)

    expect(res.status).toBe(201)
    const { replay } = await json<ReplayStartedBody>(res)
    expect(replay.sourceTaskId).toBe(id)
    expect(replay.taskId).not.toBe(id)
    expect(replay.id).toMatch(/^rpl_/)
    expect(replay.overrides).toEqual({})
    const view = await app.request(`/tasks/${replay.taskId}`, { headers: AUTH })
    expect(await json<{ spec: { origin: string; prompt: string }; state: string }>(view)).toMatchObject({
      spec: { origin: "api", prompt: "reply with the single word pong" },
      state: "received",
    })
  })

  it("rejects an executor the Bot does not allow with 400", async () => {
    const id = await finishedTask()

    const res = await post(id, { executor: "codex" })

    expect(res.status).toBe(400)
    expect(await json<ErrorBody>(res)).toMatchObject({
      error: "invalid request",
      where: "overrides.executor",
    })
  })

  it("rejects unreadable JSON and a model that looks like an option with 400", async () => {
    const id = await finishedTask()

    expect((await post(id, "{not json")).status).toBe(400)
    expect((await post(id, { model: "--dangerous" })).status).toBe(400)
  })

  it("answers 404 for an unknown or malformed task id", async () => {
    expect((await post("task_00000000-0000-4000-8000-000000000000")).status).toBe(404)
    expect((await post("nope")).status).toBe(404)
  })

  it("requires the bearer token", async () => {
    const id = await finishedTask()

    expect((await post(id, undefined, {})).status).toBe(401)
  })
})

describe("GET /replays/:id", () => {
  it("compares the source and the replay run", async () => {
    const id = await finishedTask()
    const { replay } = await json<ReplayStartedBody>(await post(id))
    await runEffect(
      Effect.gen(function* () {
        const lead = yield* Lead
        yield* lead.runOnce(yield* Schema.decodeUnknownEffect(TaskId)(replay.taskId))
      }),
    )

    const res = await app.request(`/replays/${replay.id}`, { headers: AUTH })

    expect(res.status).toBe(200)
    const body = await json<ComparisonBody>(res)
    expect(body).toMatchObject({ id: replay.id, sourceTaskId: id, newTaskId: replay.taskId, notes: [] })
    expect(body.source.verdict?.kind).toBe("ok")
    expect(body.replay.verdict?.kind).toBe("ok")
    expect(body.diff.verdictChanged).toBe(false)
    expect(body.diff.usdDelta).toBeCloseTo(0)
    expect(body.source.executor).toBe("claude-code")
  })

  it("answers 404 for an unknown replay and 401 without the token", async () => {
    expect((await app.request("/replays/rpl_nope", { headers: AUTH })).status).toBe(404)
    expect((await app.request("/replays/rpl_nope")).status).toBe(401)
  })
})
