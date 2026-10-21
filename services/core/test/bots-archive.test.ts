import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BeaconLive } from "@shoalwork/beacon"
import { BotRegistryLive } from "@shoalwork/bots"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect, Layer, ManagedRuntime, Redacted } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { makeApp } from "../src/http/app.js"
import type { RunEffect } from "../src/http/routes/respond.js"

const TOKEN = "test-token"
const AUTH = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }

const TestLayer = BotRegistryLive.pipe(Layer.provideMerge(Layer.provideMerge(BeaconLive, withTempDb())))
const runtime = ManagedRuntime.make(TestLayer)
const runEffect: RunEffect = <A, E>(eff: Effect.Effect<A, E, Layer.Success<typeof TestLayer>>) =>
  runtime.runPromise(eff)

const botsDir = mkdtempSync(join(tmpdir(), "shoalwork-bots-archive-"))
const app = makeApp({ apiToken: Redacted.make(TOKEN), runEffect, botsDir })

const SCOUT = {
  name: "scout",
  role: "researcher",
  kind: "auxiliary",
  instructions: "Find the facts and cite them.",
  executors: { preferred: "claude-code", allowed: ["claude-code"] },
  modelTiers: {},
  connectors: [],
  budget: { tokens: 300000, seconds: 900, usd: 3 },
  policy: "default",
  tank: { mode: "local", host: "mac" },
  memory: { scope: "bot" },
}

const send = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: AUTH,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

interface Body {
  readonly bot?: { readonly id: string; readonly name: string; readonly state: string }
  readonly error?: string
  readonly reason?: string
  readonly events?: ReadonlyArray<{
    readonly type: string
    readonly actor: string
    readonly payload: unknown
  }>
}
const json = async (res: Response): Promise<Body> => (await res.json()) as Body

const stateChangesOf = async (id: string) =>
  ((await json(await send("GET", `/events?stream=bot:${id}`))).events ?? []).filter(
    (event) => event.type === "bot.state_changed",
  )

// A task row in a given state, as the Lead would have left it. The archive only reads bot_id and state.
const insertTask = (botId: string, state: string) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const now = new Date().toISOString()
      yield* sql`INSERT INTO tasks (id, bot_id, spec, state, created_at, updated_at)
        VALUES (${`task_${crypto.randomUUID()}`}, ${botId}, '{}', ${state}, ${now}, ${now})`
    }),
  )

let scoutId = ""
beforeAll(async () => {
  scoutId = (await json(await send("POST", "/bots", SCOUT))).bot?.id ?? ""
})

afterAll(async () => {
  await runtime.dispose()
  rmSync(botsDir, { recursive: true, force: true })
})

describe("POST /bots/:id/archive", () => {
  it("archives an idle Bot, answers its ficha as archived and records bot.state_changed as the app", async () => {
    const res = await send("POST", `/bots/${scoutId}/archive`)
    expect(res.status).toBe(200)
    expect((await json(res)).bot).toMatchObject({ id: scoutId, name: "scout", state: "archived" })

    expect(await json(await send("GET", `/bots/${scoutId}`))).toMatchObject({ bot: { state: "archived" } })
    const changes = await stateChangesOf(scoutId)
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      actor: "user:app",
      payload: { botId: scoutId, from: "idle", to: "archived" },
    })
  })

  it("is idempotent: archiving an archived Bot answers 200 and records no new event", async () => {
    const res = await send("POST", `/bots/${scoutId}/archive`)
    expect(res.status).toBe(200)
    expect((await json(res)).bot).toMatchObject({ state: "archived" })
    expect(await stateChangesOf(scoutId)).toHaveLength(1)
  })

  it("answers 409 while the Bot holds a task in progress and leaves its state alone", async () => {
    const busy = (await json(await send("POST", "/bots", { ...SCOUT, name: "busy-scout" }))).bot?.id ?? ""
    await insertTask(busy, "running")

    const res = await send("POST", `/bots/${busy}/archive`)
    expect(res.status).toBe(409)
    expect((await json(res)).reason).toBe("bot has a task in progress")
    expect(await json(await send("GET", `/bots/${busy}`))).toMatchObject({ bot: { state: "idle" } })
    expect(await stateChangesOf(busy)).toHaveLength(0)
  })

  it("answers 409 for a task waiting for approval, and 200 when the Bot's only task is done", async () => {
    const waiting =
      (await json(await send("POST", "/bots", { ...SCOUT, name: "waiting-scout" }))).bot?.id ?? ""
    await insertTask(waiting, "waiting_approval")
    expect((await send("POST", `/bots/${waiting}/archive`)).status).toBe(409)

    const done = (await json(await send("POST", "/bots", { ...SCOUT, name: "done-scout" }))).bot?.id ?? ""
    await insertTask(done, "done")
    expect((await send("POST", `/bots/${done}/archive`)).status).toBe(200)
  })

  it("answers 404 for an unknown Bot", async () => {
    expect((await send("POST", "/bots/ghost/archive")).status).toBe(404)
  })
})
