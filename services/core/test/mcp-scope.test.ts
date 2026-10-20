import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Beacon, BeaconLive } from "@shoalwork/beacon"
import { BotRegistry, BotRegistryLive } from "@shoalwork/bots"
import { BotId, TaskId } from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { type IssuedMcpToken, McpTokens, makeMcpTokens } from "@shoalwork/lead"
import { Indexer, IndexerTest, type Reef, ReefTest } from "@shoalwork/reef"
import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { makeApp } from "../src/http/app.js"

const API_TOKEN = "test-api-token"
const HOUR = 60 * 60 * 1000

// The clock the execution tokens read. It moves only when a test says so: expiry needs no sleep.
const clock = (() => {
  let now = Date.parse("2026-10-20T12:00:00.000Z")
  return {
    read: () => new Date(now),
    advance: (ms: number) => {
      now += ms
    },
  }
})()

const TokensOnTestClock = Layer.effect(
  McpTokens,
  Effect.gen(function* () {
    const sql = yield* SqlClient
    return makeMcpTokens(sql, clock.read)
  }),
)

// One database for the whole file: the token service, the code index, the Reef and the bot registry.
type Services = McpTokens | Indexer | Reef | BotRegistry | Beacon | SqlClient
const runtime = ManagedRuntime.make(
  Layer.provideMerge(
    TokensOnTestClock,
    Layer.provideMerge(
      IndexerTest(),
      Layer.provideMerge(
        BotRegistryLive,
        Layer.provideMerge(ReefTest, Layer.provideMerge(BeaconLive, withTempDb())),
      ),
    ),
  ),
)
const runEffect = <A, E>(eff: Effect.Effect<A, E, Services>): Promise<A> => runtime.runPromise(eff)
const app = makeApp({
  apiToken: Redacted.make(API_TOKEN),
  runEffect,
  runMemory: runEffect,
  runMcp: runEffect,
})
// The same app without the MCP services: execution tokens must be refused everywhere.
const appWithoutMcp = makeApp({ apiToken: Redacted.make(API_TOKEN), runEffect, runMemory: runEffect })

const dirs: Array<string> = []
const tempDirectory = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

// A git work tree with flat files: the indexer lists files with git ls-files.
const fixtureRepo = (files: Readonly<Record<string, string>>): string => {
  const dir = tempDirectory("shoalwork-core-repo-")
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, "utf8")
  }
  execFileSync("git", ["init", "-q"], { cwd: dir })
  return dir
}

const botYaml = (name: string): string =>
  [
    `name: ${name}`,
    "role: dev",
    "kind: fixed",
    "instructions: |",
    "  You work on the repo.",
    "executors: { preferred: claude-code, allowed: [claude-code] }",
    "modelTiers: {}",
    "connectors: [telegram]",
    "budget: { tokens: 2000000, seconds: 14400, usd: 20 }",
    "policy: default",
    "tank: { mode: local, host: mac }",
    "memory: { scope: bot }",
    "",
  ].join("\n")

const newTask = (): TaskId => Schema.decodeUnknownSync(TaskId)(`task_${crypto.randomUUID()}`)

let leadId = ""
let devId = ""
let leadToken = ""
let devToken = ""
// Issued with a one-second life; it is dead once the clock moves past it (see the last block).
let shortToken = ""
let revokedToken = ""
let alphaChunk = ""
let betaChunk = ""
let taskOfRevoked: TaskId = newTask()
const ALPHA_FILE = "alpha.ts"
const BETA_FILE = "beta.ts"

const issue = (botId: string, repo: string, taskId: TaskId, ttl: number): Promise<IssuedMcpToken> =>
  runEffect(
    Effect.gen(function* () {
      const tokens = yield* McpTokens
      return yield* tokens.issue({ botId: Schema.decodeUnknownSync(BotId)(botId), repo, taskId, ttl })
    }),
  )

interface CodeHit {
  readonly id: string
  readonly path: string
  readonly content: string
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

const searchAs = async (
  token: string,
  repo: string | undefined,
  q: string,
): Promise<ReadonlyArray<CodeHit>> => {
  const query = repo === undefined ? "" : `repo=${repo}&`
  const res = await app.request(`/reef/search?${query}q=${encodeURIComponent(q)}`, { headers: bearer(token) })
  return (await res.json()) as ReadonlyArray<CodeHit>
}

beforeAll(async () => {
  const botsDir = tempDirectory("shoalwork-core-bots-")
  writeFileSync(join(botsDir, "lead.yaml"), botYaml("lead"), "utf8")
  writeFileSync(join(botsDir, "dev.yaml"), botYaml("dev"), "utf8")
  const bots = await runEffect(
    Effect.gen(function* () {
      const registry = yield* BotRegistry
      return yield* registry.syncFromDir(botsDir)
    }),
  )
  leadId = bots.find((bot) => bot.name === "lead")?.id ?? ""
  devId = bots.find((bot) => bot.name === "dev")?.id ?? ""

  const alpha = fixtureRepo({ [ALPHA_FILE]: 'export function alphaSearch() {\n  return "alpha lookup"\n}\n' })
  const beta = fixtureRepo({ [BETA_FILE]: 'export function betaSearch() {\n  return "beta lookup"\n}\n' })
  await runEffect(
    Effect.gen(function* () {
      const indexer = yield* Indexer
      yield* indexer.index(alpha, { repo: "alpha" })
      yield* indexer.index(beta, { repo: "beta" })
    }),
  )

  leadToken = Redacted.value((await issue(leadId, "alpha", newTask(), HOUR)).token)
  devToken = Redacted.value((await issue(devId, "beta", newTask(), HOUR)).token)
  shortToken = Redacted.value((await issue(leadId, "alpha", newTask(), 1000)).token)
  taskOfRevoked = newTask()
  revokedToken = Redacted.value((await issue(leadId, "alpha", taskOfRevoked, HOUR)).token)
  await runEffect(
    Effect.gen(function* () {
      const tokens = yield* McpTokens
      yield* tokens.revoke(taskOfRevoked)
    }),
  )

  await app.request("/memory", {
    method: "POST",
    headers: { authorization: `Bearer ${API_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      scope: "bot",
      ownerId: leadId,
      kind: "semantic",
      content: "deploy window is friday evening",
      userId: "renan",
    }),
  })

  alphaChunk =
    (await searchAs(API_TOKEN, "alpha", "alphaSearch")).find((hit) => hit.path === ALPHA_FILE)?.id ?? ""
  betaChunk =
    (await searchAs(API_TOKEN, "beta", "betaSearch")).find((hit) => hit.path === BETA_FILE)?.id ?? ""
})

afterAll(async () => {
  await runtime.dispose()
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const HIT_KEYS = ["content", "endLine", "id", "lang", "path", "score", "startLine", "symbols"]

describe("GET /reef/search", () => {
  it("answers the API token with the hits of the repo it names, without embeddings", async () => {
    const res = await app.request("/reef/search?repo=alpha&q=alphaSearch", { headers: bearer(API_TOKEN) })
    expect(res.status).toBe(200)
    const hits = (await res.json()) as ReadonlyArray<Record<string, unknown>>
    expect(hits.length).toBeGreaterThan(0)
    for (const hit of hits) {
      expect(Object.keys(hit).sort()).toEqual(HIT_KEYS)
    }
  })

  it("answers 400 to the API token when it names no repo", async () => {
    const res = await app.request("/reef/search?q=alphaSearch", { headers: bearer(API_TOKEN) })
    expect(res.status).toBe(400)
  })

  it("answers an execution token from its own repo when the query names none", async () => {
    const hits = await searchAs(leadToken, undefined, "alphaSearch")
    expect(hits.some((hit) => hit.path === ALPHA_FILE)).toBe(true)
    expect(hits.some((hit) => hit.path === BETA_FILE)).toBe(false)
  })

  it("answers an execution token that names its own repo", async () => {
    const res = await app.request("/reef/search?repo=alpha&q=alphaSearch", { headers: bearer(leadToken) })
    expect(res.status).toBe(200)
  })

  it("refuses an execution token a repo that is not its own with 403", async () => {
    const res = await app.request("/reef/search?repo=beta&q=betaSearch", { headers: bearer(leadToken) })
    expect(res.status).toBe(403)
  })

  it("answers the short-lived token while it is still valid", async () => {
    const res = await app.request("/reef/search?q=alphaSearch", { headers: bearer(shortToken) })
    expect(res.status).toBe(200)
  })

  it("answers 401 for a revoked execution token", async () => {
    const res = await app.request("/reef/search?q=alphaSearch", { headers: bearer(revokedToken) })
    expect(res.status).toBe(401)
  })

  it("answers 401 for a bearer that is neither the API token nor an issued token", async () => {
    const res = await app.request("/reef/search?q=alphaSearch", { headers: bearer("mcp_forged") })
    expect(res.status).toBe(401)
  })

  it("answers 401 to an execution token on HEAD and POST", async () => {
    const head = await app.request("/reef/search?q=alphaSearch", {
      method: "HEAD",
      headers: bearer(leadToken),
    })
    expect(head.status).toBe(401)
    const post = await app.request("/reef/search?q=alphaSearch", {
      method: "POST",
      headers: bearer(leadToken),
    })
    expect(post.status).toBe(401)
  })
})

describe("GET /reef/chunk/:id", () => {
  it("answers the API token with the chunk, embedding left out", async () => {
    const res = await app.request(`/reef/chunk/${alphaChunk}`, { headers: bearer(API_TOKEN) })
    expect(res.status).toBe(200)
    const chunk = (await res.json()) as Record<string, unknown>
    expect(Object.keys(chunk).sort()).toEqual(HIT_KEYS)
    expect(chunk.path).toBe(ALPHA_FILE)
  })

  it("answers an execution token with a chunk of its own repo", async () => {
    const res = await app.request(`/reef/chunk/${alphaChunk}`, { headers: bearer(leadToken) })
    expect(res.status).toBe(200)
  })

  it("refuses an execution token a chunk of another repo with 403", async () => {
    const res = await app.request(`/reef/chunk/${betaChunk}`, { headers: bearer(leadToken) })
    expect(res.status).toBe(403)
  })

  it("answers an execution token the same 403 for a missing chunk as for another repo's chunk", async () => {
    const missing = "chk_00000000-0000-4000-8000-000000000000"
    const absent = await app.request(`/reef/chunk/${missing}`, { headers: bearer(leadToken) })
    const foreign = await app.request(`/reef/chunk/${betaChunk}`, { headers: bearer(leadToken) })
    expect(absent.status).toBe(403)
    expect(foreign.status).toBe(403)
    expect(await absent.json()).toEqual(await foreign.json())
  })

  it("answers 404 to the API token for a well-formed id that names no chunk", async () => {
    const res = await app.request("/reef/chunk/chk_00000000-0000-4000-8000-000000000000", {
      headers: bearer(API_TOKEN),
    })
    expect(res.status).toBe(404)
  })

  it("answers 400 for an id that is not a chunk id", async () => {
    const res = await app.request("/reef/chunk/chk_not-a-uuid", { headers: bearer(API_TOKEN) })
    expect(res.status).toBe(400)
  })

  it("answers 401 to an execution token on a nested chunk path", async () => {
    const res = await app.request("/reef/chunk/a/b", { headers: bearer(leadToken) })
    expect(res.status).toBe(401)
  })
})

describe("GET /memory", () => {
  it("answers the API token for any Bot", async () => {
    const res = await app.request(`/memory?bot=${devId}&q=deploy`, { headers: bearer(API_TOKEN) })
    expect(res.status).toBe(200)
  })

  it("searches the token's own Bot when the query names none", async () => {
    const res = await app.request("/memory?q=deploy", { headers: bearer(leadToken) })
    expect(res.status).toBe(200)
    const hits = (await res.json()) as ReadonlyArray<{ readonly content: string }>
    expect(hits.some((hit) => hit.content.includes("deploy"))).toBe(true)
  })

  it("searches the token's own Bot when the query names it", async () => {
    const res = await app.request(`/memory?bot=${leadId}&q=deploy`, { headers: bearer(leadToken) })
    expect(res.status).toBe(200)
  })

  it("refuses a query that names another Bot with 403", async () => {
    const res = await app.request(`/memory?bot=${devId}&q=deploy`, { headers: bearer(leadToken) })
    expect(res.status).toBe(403)
  })

  it("answers the dev token with its own Bot and refuses the lead's", async () => {
    const own = await app.request("/memory?q=deploy", { headers: bearer(devToken) })
    expect(own.status).toBe(200)
    const other = await app.request(`/memory?bot=${leadId}&q=deploy`, { headers: bearer(devToken) })
    expect(other.status).toBe(403)
  })

  it("answers 401 to an execution token on a nested memory path", async () => {
    const res = await app.request("/memory/x", { headers: bearer(leadToken) })
    expect(res.status).toBe(401)
  })
})

describe("execution tokens reach only the read routes", () => {
  it("answers 401 for a write to memory", async () => {
    const res = await app.request("/memory", {
      method: "POST",
      headers: { ...bearer(leadToken), "content-type": "application/json" },
      body: JSON.stringify({ scope: "bot", ownerId: leadId, kind: "semantic", content: "x", userId: "bot" }),
    })
    expect(res.status).toBe(401)
  })

  it("answers 401 for the Bot listing", async () => {
    const res = await app.request("/bots", { headers: bearer(leadToken) })
    expect(res.status).toBe(401)
  })

  it("answers 401 for a task read", async () => {
    const res = await app.request(`/tasks/${taskOfRevoked}`, { headers: bearer(leadToken) })
    expect(res.status).toBe(401)
  })
})

describe("an app built without the MCP services", () => {
  it("answers 401 to an execution token on every read route", async () => {
    const search = await appWithoutMcp.request("/reef/search?q=alphaSearch", { headers: bearer(leadToken) })
    const memory = await appWithoutMcp.request("/memory?q=deploy", { headers: bearer(leadToken) })
    expect(search.status).toBe(401)
    expect(memory.status).toBe(401)
  })

  it("still answers the API token", async () => {
    const res = await appWithoutMcp.request(`/memory?bot=${devId}&q=deploy`, {
      headers: bearer(API_TOKEN),
    })
    expect(res.status).toBe(200)
  })
})

describe("expired execution tokens", () => {
  // Moves the clock past the short token's one second; the other tokens were issued for an hour.
  beforeAll(() => {
    clock.advance(2000)
  })

  it("answers 401 on search, chunk and memory", async () => {
    const search = await app.request("/reef/search?q=alphaSearch", { headers: bearer(shortToken) })
    const chunk = await app.request(`/reef/chunk/${alphaChunk}`, { headers: bearer(shortToken) })
    const memory = await app.request("/memory?q=deploy", { headers: bearer(shortToken) })
    expect(search.status).toBe(401)
    expect(chunk.status).toBe(401)
    expect(memory.status).toBe(401)
  })

  it("keeps the hour-long token valid after the clock moved", async () => {
    const res = await app.request("/reef/search?q=alphaSearch", { headers: bearer(leadToken) })
    expect(res.status).toBe(200)
  })
})
