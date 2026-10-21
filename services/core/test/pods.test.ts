import { withTempDb } from "@shoalwork/db/testing"
import { Effect, ManagedRuntime, Redacted } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { makeApp } from "../src/http/app.js"

// GET /pods and GET /pods/:id (T-116): steps projected from `plans` and the step tasks, usage from usage.recorded,
// messages from agent.msg. The rows are written with SQL so the test pins the stored shape the routes read.
const TOKEN = "test-token"
const AUTH = { authorization: `Bearer ${TOKEN}` }

const BOT_A = "bot_00000000-0000-4000-8000-0000000000a1"
const BOT_B = "bot_00000000-0000-4000-8000-0000000000b2"
const PLAN_TASK = "task_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
const PLAN = "plan_11111111-2222-4333-8444-555555555555"
const POD = "pod_66666666-7777-4888-8999-aaaaaaaaaaaa"
const STEP_1 = "step_00000000-0000-4000-8000-000000000001"
const STEP_2 = "step_00000000-0000-4000-8000-000000000002"
const STEP_3 = "step_00000000-0000-4000-8000-000000000003"
const TASK_1 = "task_10000000-0000-4000-8000-000000000001"
const TASK_2 = "task_10000000-0000-4000-8000-000000000002"
const T0 = "2026-10-21T10:00:00.000Z"

const runtime = ManagedRuntime.make(withTempDb())
afterAll(() => runtime.dispose())

const runEffect = <A, E>(eff: Effect.Effect<A, E, SqlClient>): Promise<A> => runtime.runPromise(eff)
const app = makeApp({ apiToken: Redacted.make(TOKEN), runEffect })

const budget = { tokens: 200000, seconds: 1800, usd: 2 }
const specOf = (id: string, title: string, parent?: unknown) =>
  JSON.stringify({
    id,
    botId: BOT_A,
    title,
    prompt: title,
    kind: "code",
    acceptance: [],
    budget,
    tier: "heavy",
    origin: "bot",
    ...(parent === undefined ? {} : { parent }),
  })

const step = (id: string, title: string, dependsOn: ReadonlyArray<string>, assignedBot?: string) => ({
  id,
  title,
  prompt: title,
  dependsOn,
  acceptance: [],
  kind: "work",
  checks: [],
  budget,
  tier: "heavy",
  parallelizable: true,
  ...(assignedBot === undefined ? {} : { assignedBot }),
})

const PLAN_JSON = JSON.stringify({
  id: PLAN,
  taskId: PLAN_TASK,
  steps: [
    step(STEP_1, "Modelar o schema", [], BOT_A),
    step(STEP_2, "Implementar a rota", [STEP_1], BOT_B),
    step(STEP_3, "Escrever os testes", [STEP_1, STEP_2]),
  ],
})

const usageEvent = (n: number, taskId: string, usd: number, tokensIn: number, tokensOut: number) => [
  `evt_00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  `task:${taskId}`,
  1,
  "usage.recorded",
  JSON.stringify({
    taskId,
    botId: BOT_A,
    executor: "claude-code",
    model: "m",
    usage: { tokensIn, tokensOut, cacheRead: 0, cacheWrite: 0, usd, seconds: 3 },
  }),
]

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`INSERT INTO bots (id, name, definition, state, updated_at) VALUES
    (${BOT_A}, 'lead', '{}', 'idle', ${T0}), (${BOT_B}, 'dev-b', '{}', 'idle', ${T0})`
  yield* sql`INSERT INTO tasks (id, bot_id, spec, state, created_at, updated_at) VALUES
    (${PLAN_TASK}, ${BOT_A}, ${specOf(PLAN_TASK, "Plano")}, 'running', ${T0}, ${T0}),
    (${TASK_1}, ${BOT_A}, ${specOf(TASK_1, "Passo 1", { planId: PLAN, stepId: STEP_1 })}, 'done', ${T0}, ${T0}),
    (${TASK_2}, ${BOT_B}, ${specOf(TASK_2, "Passo 2", { planId: PLAN, stepId: STEP_2 })}, 'running', ${T0}, ${T0})`
  yield* sql`INSERT INTO plans (id, task_id, plan, state, created_at) VALUES (${PLAN}, ${PLAN_TASK}, ${PLAN_JSON}, 'ready', ${T0})`
  yield* sql`INSERT INTO pods (id, task_id, bot_ids, thread_id, state, created_at) VALUES
    (${POD}, ${PLAN_TASK}, ${JSON.stringify([BOT_A, BOT_B])}, 7, 'open', ${T0})`
  const [first, second] = [usageEvent(1, TASK_1, 0.02, 100, 50), usageEvent(2, TASK_2, 0.01, 40, 10)]
  for (const row of [first, second]) {
    yield* sql`INSERT INTO events (id, stream_id, version, type, payload, actor, correlation_id, occurred_at)
      VALUES (${row[0]}, ${row[1]}, ${row[2]}, ${row[3]}, ${row[4]}, 'test', 'corr', ${T0})`
  }
  yield* sql`INSERT INTO events (id, stream_id, version, type, payload, actor, correlation_id, occurred_at)
    VALUES ('evt_00000000-0000-4000-8000-000000000003', ${`task:${TASK_2}`}, 2, 'agent.msg',
    ${JSON.stringify({ kind: "status", bot: BOT_B, state: "working", note: "escrevendo a rota" })}, 'test', 'corr', ${T0})`
})

interface StepBody {
  readonly id: string
  readonly title: string
  readonly state: string
  readonly botId: string | null
  readonly dependsOn: ReadonlyArray<string>
  readonly taskId: string | null
  readonly usage: { readonly usd: number; readonly tokensIn: number; readonly tokensOut: number }
}

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T

beforeAll(async () => {
  await runEffect(seed)
})

describe("GET /pods/:id", () => {
  it("builds the steps from the plan and the step tasks, with state, owner, dependencies and usage", async () => {
    const res = await app.request(`/pods/${POD}`, { headers: AUTH })
    expect(res.status).toBe(200)
    const body = await json<{
      readonly pod: { readonly name: string; readonly state: string; readonly threadId: number }
      readonly plan: { readonly id: string } | null
      readonly steps: ReadonlyArray<StepBody>
    }>(res)

    expect(body.pod).toMatchObject({ name: "pod-0a1b2c", state: "open", threadId: 7 })
    expect(body.plan?.id).toBe(PLAN)
    expect(body.steps.map((item) => [item.id, item.state, item.botId, item.dependsOn])).toEqual([
      [STEP_1, "done", BOT_A, []],
      [STEP_2, "running", BOT_B, [STEP_1]],
      [STEP_3, "pending", null, [STEP_1, STEP_2]],
    ])
    expect(body.steps[0]?.taskId).toBe(TASK_1)
    expect(body.steps[2]?.taskId).toBeNull()
    expect(body.steps[0]?.usage).toEqual({ usd: 0.02, tokensIn: 100, tokensOut: 50 })
    expect(body.steps[2]?.usage).toEqual({ usd: 0, tokensIn: 0, tokensOut: 0 })
  })

  it("carries the agent messages of the steps, mapped to their step", async () => {
    const body = await json<{
      readonly messages: ReadonlyArray<{
        readonly stepId: string | null
        readonly kind: string
        readonly text: string
      }>
    }>(await app.request(`/pods/${POD}`, { headers: AUTH }))
    expect(body.messages).toEqual([
      expect.objectContaining({ stepId: STEP_2, kind: "status", text: "escrevendo a rota" }),
    ])
  })

  it("answers 404 for an unknown or malformed Pod id", async () => {
    const unknown = await app.request("/pods/pod_00000000-0000-4000-8000-000000000000", { headers: AUTH })
    expect(unknown.status).toBe(404)
    const malformed = await app.request("/pods/not-a-pod", { headers: AUTH })
    expect(malformed.status).toBe(404)
  })

  it("requires the API token", async () => {
    expect((await app.request(`/pods/${POD}`)).status).toBe(401)
  })
})

describe("GET /pods", () => {
  it("lists the open Pods with steps done, steps total and cost", async () => {
    const res = await app.request("/pods?state=open", { headers: AUTH })
    expect(res.status).toBe(200)
    const body = await json<{
      readonly pods: ReadonlyArray<{
        readonly id: string
        readonly name: string
        readonly stepsDone: number
        readonly stepsTotal: number
        readonly costUsd: number
      }>
    }>(res)
    expect(body.pods).toEqual([
      expect.objectContaining({ id: POD, name: "pod-0a1b2c", stepsDone: 1, stepsTotal: 3, costUsd: 0.03 }),
    ])
  })

  it("filters by state and refuses an unknown state", async () => {
    const closed = await json<{ readonly pods: ReadonlyArray<unknown> }>(
      await app.request("/pods?state=closed", { headers: AUTH }),
    )
    expect(closed.pods).toEqual([])
    const invalid = await app.request("/pods?state=paused", { headers: AUTH })
    expect(invalid.status).toBe(400)
  })
})
