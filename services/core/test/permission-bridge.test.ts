import { readFileSync } from "node:fs"
import { BeaconLive } from "@shoalwork/beacon"
import { BotId, newApprovalId, newTaskId, type TaskId } from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { McpTokens, McpTokensLive } from "@shoalwork/lead"
import { Approvals, ApprovalsLive, makePolicyTest, type Policy } from "@shoalwork/policy"
import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { afterAll, describe, expect, it } from "vitest"
import { makeApp } from "../src/http/app.js"

const DEFAULT_YAML = readFileSync(new URL("../../../config/policies/default.yaml", import.meta.url), "utf8")
const BOT = Schema.decodeUnknownSync(BotId)("bot_3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41")
const TREE = "/work/tree"

// No standing workspace root: the only root is the one bound to the run's token.
type Services = Policy | Approvals | McpTokens | SqlClient
const layer = makePolicyTest({ sources: { default: DEFAULT_YAML }, policyOf: () => "default" }).pipe(
  Layer.provideMerge(ApprovalsLive),
  Layer.provideMerge(McpTokensLive),
  Layer.provideMerge(BeaconLive),
  Layer.provideMerge(withTempDb()),
)
const runtime = ManagedRuntime.make(layer)
afterAll(() => runtime.dispose())
const run = <A, E>(eff: Effect.Effect<A, E, Services>): Promise<A> => runtime.runPromise(eff)
// Each runner is typed with only what its routes need (the production runner has every service).
const runSql = <A, E>(eff: Effect.Effect<A, E, SqlClient>): Promise<A> => runtime.runPromise(eff)
const runTokens = <A, E>(eff: Effect.Effect<A, E, McpTokens | SqlClient>): Promise<A> =>
  runtime.runPromise(eff)
const runPolicy = <A, E>(eff: Effect.Effect<A, E, Policy | Approvals>): Promise<A> => runtime.runPromise(eff)
const app = makeApp({
  apiToken: Redacted.make("test-api-token"),
  runEffect: runSql,
  runMcp: runTokens,
  runPolicy,
})

// A task of the Bot and its execution token; the worktree is bound only when `cwd` is given.
const startRun = (cwd: string | undefined, bridgeMode: "inline" | "resume" | "none" = "inline") =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const tokens = yield* McpTokens
      const taskId: TaskId = newTaskId()
      const now = new Date(0).toISOString()
      yield* sql`INSERT OR IGNORE INTO bots (id, name, definition, state, updated_at)
        VALUES (${BOT}, 'bridge', '{}', 'idle', ${now})`
      yield* sql`INSERT INTO tasks (id, bot_id, spec, state, created_at, updated_at)
        VALUES (${taskId}, ${BOT}, '{}', 'running', ${now}, ${now})`
      const issued = yield* tokens.issue({
        botId: BOT,
        repo: "shoalwork",
        taskId,
        ttl: 3_600_000,
        ...(bridgeMode === "none" ? {} : { bridgeMode }),
      })
      if (cwd !== undefined) yield* tokens.bindWorkspace(taskId, cwd)
      return { taskId, token: Redacted.value(issued.token) }
    }),
  )

const Answer = Schema.Struct({
  effect: Schema.String,
  approvalId: Schema.optional(Schema.String),
})

const evaluate = async (token: string, body: unknown) => {
  const response = await app.request("/policy/evaluate", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  return { status: response.status, answer: Schema.decodeUnknownSync(Answer)(await response.json()) }
}

const write = (path: string) => ({ tool: "Write", input: { file_path: path, content: "x" } })
const PUSH = { tool: "Bash", input: { command: "git push origin main" } }

describe("permission bridge wiring", () => {
  it("the worktree bound to the token is the workspace of that run, and only of it", async () => {
    const bound = await startRun(TREE)
    expect((await evaluate(bound.token, write(`${TREE}/src/a.ts`))).answer.effect).toBe("allow")
    expect((await evaluate(bound.token, write("/other/place/a.ts"))).answer.effect).toBe("ask")
    const unbound = await startRun(undefined)
    expect((await evaluate(unbound.token, write(`${TREE}/src/a.ts`))).answer.effect).toBe("ask")
  })

  it("a cwd in the body of an execution token widens nothing", async () => {
    const bound = await startRun(TREE)
    const { status, answer } = await evaluate(bound.token, { ...write("/etc-like/a.ts"), cwd: "/etc-like" })
    expect(status).toBe(200)
    expect(answer.effect).toBe("ask")
  })

  it("an ask of a bridge run is stored as inline", async () => {
    const { token } = await startRun(TREE)
    const { answer } = await evaluate(token, PUSH)
    expect(answer.effect).toBe("ask")
    const rows = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient
        return yield* sql`SELECT mode FROM approvals WHERE id = ${answer.approvalId ?? ""}`
      }),
    )
    expect(rows.map((row) => row.mode)).toEqual(["inline"])
  })

  // Restart: the run resumes its session and asks again. A decision already used is never spent twice.
  it("an approval already used does not cover the same call again: the call is asked anew", async () => {
    const { taskId, token } = await startRun(TREE)
    const first = (await evaluate(token, PUSH)).answer
    expect(first.effect).toBe("ask")
    await run(
      Effect.gen(function* () {
        const approvals = yield* Approvals
        const rows = yield* approvals.listPending()
        const open = rows.find((row) => row.taskId === taskId)
        if (open === undefined) return yield* Effect.die("no pending approval")
        yield* approvals.resolve(open.id, "approved", "user:cli")
      }),
    )
    const spent = (await evaluate(token, PUSH)).answer
    expect(spent).toEqual({ effect: "allow", approvalId: first.approvalId })
    const again = (await evaluate(token, PUSH)).answer
    expect(again.effect).toBe("ask")
    expect(again.approvalId).not.toBe(first.approvalId)
  })

  // Only a token issued for the bridge in inline mode reaches the two routes. Without PERMISSION_BRIDGE nothing issues
  // such a token, so no execution token gets in.
  it("refuses an execution token that was not issued for the inline bridge, on both routes", async () => {
    for (const mode of ["none", "resume"] as const) {
      const { token } = await startRun(TREE, mode)
      const evaluated = await app.request("/policy/evaluate", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(PUSH),
      })
      expect(evaluated.status).toBe(403)
      const waited = await app.request(`/approvals/${newApprovalId()}/wait?timeoutMs=1`, {
        headers: { authorization: `Bearer ${token}` },
      })
      expect(waited.status).toBe(403)
    }
  })
})
