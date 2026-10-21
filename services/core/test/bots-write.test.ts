import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BeaconLive } from "@shoalwork/beacon"
import { BotRegistryLive } from "@shoalwork/bots"
import { withTempDb } from "@shoalwork/db/testing"
import { type Effect, Layer, ManagedRuntime, Redacted } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { makeApp } from "../src/http/app.js"
import { cloneName } from "../src/http/routes/bots-write.js"
import type { RunEffect } from "../src/http/routes/respond.js"

const TOKEN = "test-token"
const AUTH = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }

const TestLayer = BotRegistryLive.pipe(Layer.provideMerge(Layer.provideMerge(BeaconLive, withTempDb())))
const runtime = ManagedRuntime.make(TestLayer)
const runEffect: RunEffect = <A, E>(eff: Effect.Effect<A, E, Layer.Success<typeof TestLayer>>) =>
  runtime.runPromise(eff)

const botsDir = mkdtempSync(join(tmpdir(), "shoalwork-bots-write-"))
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

// The shapes this file reads from the responses; the assertions after each call check the values.
interface Body {
  readonly bot: {
    readonly id: string
    readonly name: string
    readonly role: string
    readonly state: string
    readonly telegram?: unknown
  }
  readonly bots: ReadonlyArray<{ readonly name: string }>
  readonly issues: ReadonlyArray<unknown>
  readonly where: string
  readonly events: ReadonlyArray<{ readonly type: string; readonly payload: unknown }>
}
const json = async <T = Body>(res: Response): Promise<T> => (await res.json()) as T

let scoutId = ""
beforeAll(async () => {
  const res = await send("POST", "/bots", SCOUT)
  scoutId = (await json(res)).bot.id
})

afterAll(async () => {
  await runtime.dispose()
  rmSync(botsDir, { recursive: true, force: true })
})

const eventsOf = async (id: string) => (await json(await send("GET", `/events?stream=bot:${id}`))).events

describe("POST /bots", () => {
  it("writes the yaml and the registry row together", async () => {
    expect(existsSync(join(botsDir, "scout.yaml"))).toBe(true)
    const res = await send("GET", "/bots/scout")
    expect(res.status).toBe(200)
    expect((await json(res)).bot).toMatchObject({ name: "scout", state: "idle" })
  })

  it("answers 409 for a name already taken", async () => {
    expect((await send("POST", "/bots", SCOUT)).status).toBe(409)
  })

  it("answers 400 with issues for an invalid name", async () => {
    const res = await send("POST", "/bots", { ...SCOUT, name: "Bad Name!" })
    expect(res.status).toBe(400)
    expect((await json(res)).issues.length).toBeGreaterThan(0)
  })
})

describe("PATCH /bots/:id", () => {
  it("replaces the yaml and the row and records bot.updated", async () => {
    const res = await send("PATCH", `/bots/${scoutId}`, { role: "analyst" })
    expect(res.status).toBe(200)
    expect((await json(res)).bot).toMatchObject({ role: "analyst", state: "idle" })
    expect(readFileSync(join(botsDir, "scout.yaml"), "utf8")).toContain("role: analyst")
    expect(await json(await send("GET", `/bots/${scoutId}`))).toMatchObject({ bot: { role: "analyst" } })
    const updated = (await eventsOf(scoutId)).filter((e: { type: string }) => e.type === "bot.updated")
    expect(updated.at(-1)?.payload).toMatchObject({
      botId: scoutId,
      fields: ["role"],
      by: "api",
      sensitive: false,
    })
  })

  it("marks a budget change as sensitive", async () => {
    const res = await send("PATCH", `/bots/${scoutId}`, { budget: { tokens: 1000, seconds: 60, usd: 0.5 } })
    expect(res.status).toBe(200)
    const updated = (await eventsOf(scoutId)).filter((e: { type: string }) => e.type === "bot.updated")
    expect(updated.at(-1)?.payload).toMatchObject({ fields: ["budget"], sensitive: true })
  })

  it("answers 400 for an invalid field and leaves the file untouched", async () => {
    const before = readFileSync(join(botsDir, "scout.yaml"), "utf8")
    const res = await send("PATCH", `/bots/${scoutId}`, { budget: { tokens: -1, seconds: 60, usd: 0.5 } })
    expect(res.status).toBe(400)
    expect((await json(res)).issues.length).toBeGreaterThan(0)
    expect(readFileSync(join(botsDir, "scout.yaml"), "utf8")).toBe(before)
  })

  it("refuses to change the name and unknown keys with 400", async () => {
    expect((await send("PATCH", `/bots/${scoutId}`, { name: "other" })).status).toBe(400)
    expect((await json(await send("PATCH", `/bots/${scoutId}`, { name: "other" }))).where).toBe("bot.name")
    expect((await send("PATCH", `/bots/${scoutId}`, { zzz: 1 })).status).toBe(400)
  })

  it("answers 404 for an unknown id", async () => {
    expect((await send("PATCH", "/bots/ghost", { role: "x" })).status).toBe(404)
  })

  it("answers 409 for a Bot without a definition file", async () => {
    const res = await send("POST", `/bots/${scoutId}/clone`)
    expect(res.status).toBe(201)
    const cloneId = (await json(res)).bot.id
    unlinkSync(join(botsDir, "scout-copy.yaml"))
    expect((await send("PATCH", `/bots/${cloneId}`, { role: "x" })).status).toBe(409)
  })
})

describe("POST /bots/:id/clone", () => {
  it("takes the -copy name, then -copy-2, and drops telegram", async () => {
    // "scout-copy" is already taken by the clone of the 409 test (its file was removed, its row stayed).
    const first = await send("POST", `/bots/${scoutId}/clone`)
    expect(first.status).toBe(201)
    expect((await json(first)).bot.name).toBe("scout-copy-2")
    const second = await send("POST", `/bots/${scoutId}/clone`)
    const copy = (await json(second)).bot
    expect(copy.name).toBe("scout-copy-3")
    expect(existsSync(join(botsDir, "scout-copy-3.yaml"))).toBe(true)
    expect(copy.telegram).toBeUndefined()
  })

  it("keeps a clone name inside BotName", () => {
    const name = cloneName("a".repeat(31), 1)
    expect(name.length).toBeLessThanOrEqual(31)
    expect(name.endsWith("-copy")).toBe(true)
  })

  it("answers 404 for an unknown source", async () => {
    expect((await send("POST", "/bots/ghost/clone")).status).toBe(404)
  })
})

describe("the effect of a write is visible to the next read", () => {
  it("lists the clones", async () => {
    const bots = (await json(await send("GET", "/bots"))).bots as Array<{ name: string }>
    expect(bots.map((bot) => bot.name)).toEqual(
      expect.arrayContaining(["scout", "scout-copy", "scout-copy-2", "scout-copy-3"]),
    )
  })
})
