import { readFileSync } from "node:fs"
import { BeaconLive } from "@shoalwork/beacon"
import { BotId, newTaskId, type TaskId } from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { McpTokens, McpTokensLive } from "@shoalwork/lead"
import { Approvals, ApprovalsLive, makePolicyTest, type Policy } from "@shoalwork/policy"
import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { makeApp } from "../src/http/app.js"

const API_TOKEN = "test-api-token"
const DEFAULT_YAML = readFileSync(new URL("../../../config/policies/default.yaml", import.meta.url), "utf8")
const BOT = Schema.decodeUnknownSync(BotId)("bot_3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41")
const OTHER_BOT = Schema.decodeUnknownSync(BotId)("bot_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d")

const ROOT = "/work/tree"

type Services = Policy | Approvals | McpTokens | SqlClient
const layer = makePolicyTest({
  sources: { default: DEFAULT_YAML },
  policyOf: () => "default",
  workspaceRoots: [ROOT],
}).pipe(
  Layer.provideMerge(ApprovalsLive),
  Layer.provideMerge(McpTokensLive),
  Layer.provideMerge(BeaconLive),
  Layer.provideMerge(withTempDb()),
)
const runtime = ManagedRuntime.make(layer)
const runEffect = <A, E>(eff: Effect.Effect<A, E, Services>): Promise<A> => runtime.runPromise(eff)
// Each runner is typed with only what its routes need (the production runner has every service).
const runSql = <A, E>(eff: Effect.Effect<A, E, SqlClient>): Promise<A> => runtime.runPromise(eff)
const runTokens = <A, E>(eff: Effect.Effect<A, E, McpTokens | SqlClient>): Promise<A> =>
  runtime.runPromise(eff)
const runPolicy = <A, E>(eff: Effect.Effect<A, E, Policy | Approvals>): Promise<A> => runtime.runPromise(eff)
const app = makeApp({ apiToken: Redacted.make(API_TOKEN), runEffect: runSql, runMcp: runTokens, runPolicy })
// Same services, bridge routes not mounted: an execution token must reach nothing there.
const appWithoutPolicy = makeApp({ apiToken: Redacted.make(API_TOKEN), runEffect: runSql, runMcp: runTokens })

const seedTask = (botId: BotId): Promise<TaskId> =>
  runEffect(
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const taskId = newTaskId()
      const now = new Date(0).toISOString()
      yield* sql`INSERT OR IGNORE INTO bots (id, name, definition, state, updated_at)
        VALUES (${botId}, ${`bot-${botId}`}, '{}', 'idle', ${now})`
      yield* sql`INSERT INTO tasks (id, bot_id, spec, state, created_at, updated_at)
        VALUES (${taskId}, ${botId}, '{}', 'working', ${now}, ${now})`
      return taskId
    }),
  )

const tokenFor = (botId: BotId, taskId: TaskId): Promise<string> =>
  runEffect(
    Effect.gen(function* () {
      const tokens = yield* McpTokens
      const issued = yield* tokens.issue({ botId, repo: "shoalwork", taskId, ttl: 60 * 60 * 1000 })
      return Redacted.value(issued.token)
    }),
  )

const post = (token: string, body: unknown, target = app) =>
  target.request("/policy/evaluate", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  })

const wait = (token: string, id: string, query = "?timeoutMs=1", target = app) =>
  target.request(`/approvals/${id}/wait${query}`, { headers: { authorization: `Bearer ${token}` } })

const PUSH = { tool: "Bash", input: { command: "git push origin main" } }

let taskId: TaskId
let token = ""
beforeAll(async () => {
  taskId = await seedTask(BOT)
  token = await tokenFor(BOT, taskId)
})
afterAll(() => runtime.dispose())

const decide = (approvalId: string, decision: "approved" | "denied") =>
  runEffect(
    Effect.flatMap(Approvals, (approvals) =>
      approvals.resolve(approvalId as Parameters<typeof approvals.resolve>[0], decision, "user:cli"),
    ),
  )

describe("POST /policy/evaluate", () => {
  it("answers allow and deny from the Policy, with the rule's reason on deny", async () => {
    const allow = await post(token, { tool: "Read", input: { file_path: "src/a.ts" } })
    expect(allow.status).toBe(200)
    expect(await allow.json()).toEqual({ effect: "allow" })
    const deny = await post(token, { tool: "Bash", input: { command: "rm -rf /" } })
    expect(await deny.json()).toEqual({ effect: "deny", reason: "recursive delete of the root" })
  })

  it("asks for an external action and keeps one open request while it is pending", async () => {
    const first = (await (await post(token, PUSH)).json()) as { effect: string; approvalId: string }
    expect(first.effect).toBe("ask")
    expect(first.approvalId).toMatch(/^apr_/)
    const again = (await (await post(token, PUSH)).json()) as { approvalId: string }
    expect(again.approvalId).toBe(first.approvalId)
  })

  it("an approval allows the exact call once; a different input asks again; a second use asks again", async () => {
    const ownTask = await seedTask(BOT)
    const own = await tokenFor(BOT, ownTask)
    const asked = (await (await post(own, PUSH)).json()) as { approvalId: string }
    await decide(asked.approvalId, "approved")
    const other = { tool: "Bash", input: { command: "git push origin feature" } }
    expect(((await (await post(own, other)).json()) as { effect: string }).effect).toBe("ask")
    const used = (await (await post(own, PUSH)).json()) as { effect: string; approvalId: string }
    expect(used).toEqual({ effect: "allow", approvalId: asked.approvalId })
    const second = (await (await post(own, PUSH)).json()) as { effect: string; approvalId: string }
    expect(second.effect).toBe("ask")
    expect(second.approvalId).not.toBe(asked.approvalId)
  })

  it("a denied approval does not allow the call", async () => {
    const ownTask = await seedTask(BOT)
    const own = await tokenFor(BOT, ownTask)
    const asked = (await (await post(own, PUSH)).json()) as { approvalId: string }
    await decide(asked.approvalId, "denied")
    expect(((await (await post(own, PUSH)).json()) as { effect: string }).effect).toBe("ask")
  })

  it("an approval of another task never allows this task's call", async () => {
    const taskA = await seedTask(BOT)
    const taskB = await seedTask(BOT)
    const tokenA = await tokenFor(BOT, taskA)
    const tokenB = await tokenFor(BOT, taskB)
    const asked = (await (await post(tokenA, PUSH)).json()) as { approvalId: string }
    await decide(asked.approvalId, "approved")
    expect(((await (await post(tokenB, PUSH)).json()) as { effect: string }).effect).toBe("ask")
  })

  it("refuses an execution token that names another Bot or task, and accepts its own ids", async () => {
    expect((await post(token, { ...PUSH, botId: OTHER_BOT })).status).toBe(403)
    expect((await post(token, { ...PUSH, taskId: newTaskId() })).status).toBe(403)
    expect((await post(token, { tool: "Read", input: {}, botId: BOT, taskId })).status).toBe(200)
  })

  it("makes the API token name the Bot and the task, then acts for them", async () => {
    expect((await post(API_TOKEN, PUSH)).status).toBe(400)
    const named = await post(API_TOKEN, { ...PUSH, botId: BOT, taskId })
    expect(named.status).toBe(200)
    expect(((await named.json()) as { effect: string }).effect).toBe("ask")
  })

  it("rejects a malformed body with 400", async () => {
    expect((await post(token, { input: {} })).status).toBe(400)
    expect((await post(token, "nope")).status).toBe(400)
  })

  it("answers 401 without a valid token and to an execution token when the routes are not mounted", async () => {
    expect((await app.request("/policy/evaluate", { method: "POST", body: "{}" })).status).toBe(401)
    expect((await post("mcp_unknown", PUSH)).status).toBe(401)
    expect((await post(token, PUSH, appWithoutPolicy)).status).toBe(401)
    expect((await post(API_TOKEN, { ...PUSH, botId: BOT, taskId }, appWithoutPolicy)).status).toBe(404)
  })

  it("an execution token still cannot reach any other write route", async () => {
    const response = await app.request("/approvals/apr_00000000-0000-4000-8000-000000000000", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ decision: "approved" }),
    })
    expect(response.status).toBe(401)
    expect((await app.request("/approvals", { headers: { authorization: `Bearer ${token}` } })).status).toBe(
      401,
    )
  })
})

describe("GET /approvals/:id/wait", () => {
  it("reports pending, then the decision", async () => {
    const ownTask = await seedTask(BOT)
    const own = await tokenFor(BOT, ownTask)
    const asked = (await (await post(own, PUSH)).json()) as { approvalId: string }
    expect(await (await wait(own, asked.approvalId)).json()).toEqual({ status: "pending" })
    await decide(asked.approvalId, "approved")
    expect(await (await wait(own, asked.approvalId, "")).json()).toEqual({ status: "approved" })
  })

  it("reads another task's approval as forbidden, and an unknown id the same for a token but 404 for the API", async () => {
    const asked = (await (await post(token, PUSH)).json()) as { approvalId: string }
    const otherTask = await seedTask(BOT)
    const other = await tokenFor(BOT, otherTask)
    expect((await wait(other, asked.approvalId)).status).toBe(403)
    const missing = "apr_00000000-0000-4000-8000-000000000000"
    expect((await wait(token, missing)).status).toBe(403)
    expect((await wait(API_TOKEN, missing)).status).toBe(404)
    expect((await wait(API_TOKEN, "not-an-id")).status).toBe(404)
    expect((await wait(API_TOKEN, asked.approvalId)).status).toBe(200)
  })

  it("rejects a timeout that is not a positive integer, and answers 401 without a token", async () => {
    const asked = (await (await post(token, PUSH)).json()) as { approvalId: string }
    expect((await wait(token, asked.approvalId, "?timeoutMs=0")).status).toBe(400)
    expect((await wait(token, asked.approvalId, "?timeoutMs=abc")).status).toBe(400)
    expect((await app.request(`/approvals/${asked.approvalId}/wait`)).status).toBe(401)
  })
})

const WRITE_OUTSIDE = { tool: "Write", input: { file_path: "/srv/other/x.txt", content: "a" } }
const effectOf = async (response: Response): Promise<string> =>
  ((await response.json()) as { effect: string }).effect

describe("workspace of the evaluated call", () => {
  it("ignores the cwd of an execution token: a write outside the worktree still asks", async () => {
    expect(await effectOf(await post(token, { ...WRITE_OUTSIDE, cwd: "/" }))).toBe("ask")
    expect(await effectOf(await post(token, { ...WRITE_OUTSIDE, cwd: "/srv" }))).toBe("ask")
    const inside = { tool: "Write", input: { file_path: `${ROOT}/a.txt`, content: "a" }, cwd: "/" }
    expect(await effectOf(await post(token, inside))).toBe("allow")
  })

  it("accepts an API cwd only when it is a configured workspace root", async () => {
    const named = { botId: BOT, taskId }
    expect((await post(API_TOKEN, { ...WRITE_OUTSIDE, ...named, cwd: "/" })).status).toBe(400)
    expect((await post(API_TOKEN, { ...WRITE_OUTSIDE, ...named, cwd: "/srv" })).status).toBe(400)
    const rooted = await post(API_TOKEN, { ...WRITE_OUTSIDE, ...named, cwd: ROOT })
    expect(await effectOf(rooted)).toBe("ask")
  })
})

describe("request size", () => {
  it("answers 413 to an evaluate body over 256 KB, declared or streamed, and to a wait that declares one", async () => {
    const big = { tool: "Bash", input: { command: "x".repeat(300_000) } }
    expect((await post(token, big)).status).toBe(413)
    const streamed = await app.request("/policy/evaluate", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify(big)))
          controller.close()
        },
      }),
      duplex: "half",
    } as RequestInit)
    expect(streamed.status).toBe(413)
    const asked = (await (await post(token, PUSH)).json()) as { approvalId: string }
    const declared = await app.request(`/approvals/${asked.approvalId}/wait?timeoutMs=1`, {
      headers: { authorization: `Bearer ${token}`, "content-length": "999999" },
    })
    expect(declared.status).toBe(413)
    expect((await post(token, PUSH)).status).toBe(200)
  })
})

const expireNow = (id: string) =>
  runEffect(
    Effect.gen(function* () {
      const sql = yield* SqlClient
      yield* sql`UPDATE approvals SET expires_at = ${new Date(0).toISOString()} WHERE id = ${id}`
    }),
  )

describe("expired approvals", () => {
  it("a pending approval past its expiry reads as expired and is not written by the route", async () => {
    const ownTask = await seedTask(BOT)
    const own = await tokenFor(BOT, ownTask)
    const asked = (await (await post(own, PUSH)).json()) as { approvalId: string }
    await expireNow(asked.approvalId)
    expect(await (await wait(own, asked.approvalId)).json()).toEqual({ status: "expired" })
    const stored = (await runEffect(
      Effect.flatMap(Approvals, (approvals) =>
        approvals.get(asked.approvalId as Parameters<typeof approvals.get>[0]),
      ),
    )) as { status: string }
    expect(stored.status).toBe("pending")
  })

  it("an approval expired for its task reports expired, and the next call opens a new request", async () => {
    const ownTask = await seedTask(BOT)
    const own = await tokenFor(BOT, ownTask)
    const asked = (await (await post(own, PUSH)).json()) as { approvalId: string }
    await runEffect(
      Effect.flatMap(Approvals, (approvals) => approvals.expireForTask(ownTask, "system:task-closed")),
    )
    expect(await (await wait(own, asked.approvalId)).json()).toEqual({ status: "expired" })
    const again = (await (await post(own, PUSH)).json()) as { effect: string; approvalId: string }
    expect(again.effect).toBe("ask")
    expect(again.approvalId).not.toBe(asked.approvalId)
  })
})
