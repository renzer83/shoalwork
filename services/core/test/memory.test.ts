import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Beacon, BeaconLive } from "@shoalwork/beacon"
import { BotRegistry, BotRegistryLive } from "@shoalwork/bots"
import { withTempDb } from "@shoalwork/db/testing"
import { type Reef, ReefTest } from "@shoalwork/reef"
import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { makeApp } from "../src/http/app.js"

const TOKEN = "test-token"
const AUTH = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }

// The core runner needs only the Beacon here; the memory runner gets the registry and Reef over a fresh migrated
// database and the deterministic embedder (no network).
const coreRuntime = ManagedRuntime.make(Layer.provideMerge(BeaconLive, withTempDb()))
const memoryRuntime = ManagedRuntime.make(
  Layer.provideMerge(
    BotRegistryLive,
    Layer.provideMerge(ReefTest, Layer.provideMerge(BeaconLive, withTempDb())),
  ),
)

const runEffect = <A, E>(eff: Effect.Effect<A, E, Beacon>): Promise<A> => coreRuntime.runPromise(eff)
const runMemory = <A, E>(eff: Effect.Effect<A, E, Reef | SqlClient | BotRegistry>): Promise<A> =>
  memoryRuntime.runPromise(eff)
const app = makeApp({ apiToken: Redacted.make(TOKEN), runEffect, runMemory })

const BOT_YAML = [
  "name: lead",
  "role: coordinator",
  "kind: fixed",
  "instructions: |",
  "  You are the Lead.",
  "executors: { preferred: claude-code, allowed: [claude-code] }",
  "modelTiers: {}",
  "connectors: [telegram]",
  "budget: { tokens: 2000000, seconds: 14400, usd: 20 }",
  "policy: default",
  "tank: { mode: local, host: mac }",
  "memory: { scope: bot }",
  "",
].join("\n")

const dirs: Array<string> = []
const markdownDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "shoalwork-core-md-"))
  dirs.push(dir)
  writeFileSync(join(dir, "soul.md"), "# Lead\n\nCoordena os bots.\n", "utf8")
  return dir
}

// The bot the "bot:lead" scope resolves to, synced once from a temp bots directory.
let leadId = ""
beforeAll(async () => {
  const botsDir = mkdtempSync(join(tmpdir(), "shoalwork-core-bots-"))
  dirs.push(botsDir)
  writeFileSync(join(botsDir, "lead.yaml"), BOT_YAML, "utf8")
  const bots = await runMemory(
    Effect.gen(function* () {
      const registry = yield* BotRegistry
      return yield* registry.syncFromDir(botsDir)
    }),
  )
  leadId = bots[0]?.id ?? ""
})

afterAll(async () => {
  await coreRuntime.dispose()
  await memoryRuntime.dispose()
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const OwnerRow = Schema.Struct({ owner: Schema.String })
const ownersInMemory = (): Promise<ReadonlyArray<typeof OwnerRow.Type>> =>
  memoryRuntime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const rows = yield* sql`SELECT DISTINCT owner_id AS owner FROM memory_items ORDER BY owner`
      return yield* Schema.decodeUnknownEffect(Schema.Array(OwnerRow))(rows)
    }).pipe(Effect.orDie),
  )

const post = (body: unknown) =>
  app.request("/memory/import", {
    method: "POST",
    headers: AUTH,
    body: typeof body === "string" ? body : JSON.stringify(body),
  })

describe("POST /memory/import", () => {
  it("rejects requests without the bearer token", async () => {
    const res = await app.request("/memory/import", { method: "POST", body: "{}" })
    expect(res.status).toBe(401)
  })

  it("answers 400 when the body is not JSON", async () => {
    const res = await post("{not json")
    expect(res.status).toBe(400)
  })

  it("answers 400 for a kind outside semantic and procedural", async () => {
    const res = await post({ dir: markdownDir(), scope: "global", kind: "working", source: "soul" })
    expect(res.status).toBe(400)
  })

  it("answers 400 for a scope other than global or bot:<name>", async () => {
    const res = await post({ dir: markdownDir(), scope: "pod:x", kind: "semantic", source: "soul" })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: "invalid request" })
  })

  it("answers 400 for a relative directory", async () => {
    const res = await post({ dir: "relative/dir", scope: "global", kind: "semantic", source: "soul" })
    expect(res.status).toBe(400)
  })

  it("answers 400 when the directory does not exist", async () => {
    const res = await post({
      dir: "/nonexistent-shoalwork-core-import",
      scope: "global",
      kind: "semantic",
      source: "soul",
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: "cannot read directory" })
  })

  it("answers 404 naming the bot when the scope names no registered bot", async () => {
    const res = await post({ dir: markdownDir(), scope: "bot:ghost", kind: "semantic", source: "soul" })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "unknown bot", name: "ghost" })
  })

  it("stores bot:<name> under the BotId and answers the report; a second call creates nothing", async () => {
    expect(leadId).toMatch(/^bot_/)
    const dir = markdownDir()
    const body = { dir, scope: "bot:lead", kind: "semantic", source: "soul" }
    const first = await post(body)
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({ files: 1, chunks: 1, created: 1, unchanged: 0 })
    expect(await ownersInMemory()).toEqual([{ owner: leadId }])
    const second = await post(body)
    expect(second.status).toBe(200)
    expect(await second.json()).toMatchObject({ files: 1, chunks: 1, created: 0, unchanged: 1, forgotten: 0 })
  })
})
