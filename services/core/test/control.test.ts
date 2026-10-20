import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BeaconLive } from "@shoalwork/beacon"
import { BotRegistry, BotRegistryLive } from "@shoalwork/bots"
import { type Bot, ExecutorId, NewBot } from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { type Executor, makeRegistry } from "@shoalwork/executors"
import { Lead, LeadWithStore } from "@shoalwork/lead"
import { Tank, TankLocalLive } from "@shoalwork/tank"
import { Effect, Layer, ManagedRuntime, Redacted, Schema, Stream } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { makeApp } from "../src/http/app.js"
import type { RunEffect } from "../src/http/routes/respond.js"
import { DEFAULT_TIERS } from "../src/model-tiers.js"
import { runWatchdogCycle } from "../src/watchdog.js"

const TOKEN = "test-token"
const AUTH = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }

// A task whose prompt says "hang" runs a real `sleep` in its Bot's Tank and never ends by itself; any other prompt
// finishes at once. The pids tell the test whether the process group is gone.
const pids: Array<number> = []
const pidOfTask = new Map<string, number>()

const CLAUDE = Schema.decodeUnknownSync(ExecutorId)("claude-code")

const executor: Executor = {
  id: CLAUDE,
  run: (task, ctx) =>
    task.prompt.includes("hang")
      ? Stream.unwrap(
          Effect.gen(function* () {
            const tank = yield* Tank
            const proc = yield* tank.spawnStream(ctx, ["sleep", "120"]).pipe(Effect.orDie)
            pids.push(proc.pid)
            pidOfTask.set(task.taskId, proc.pid)
            return Stream.never
          }),
        )
      : Stream.make({ kind: "done" as const, result: "ok", artifacts: [] }),
  mapTier: () => ({ model: "fake" }),
  quota: () => Effect.succeed({ executor: CLAUDE, usedRatio: 0, available: true }),
}

const tankRoot = mkdtempSync(join(tmpdir(), "shoalwork-control-tank-"))
const TestLayer = LeadWithStore(DEFAULT_TIERS).pipe(
  Layer.provideMerge(
    Layer.mergeAll(BotRegistryLive, TankLocalLive({ root: tankRoot, baseEnv: {} }), makeRegistry([executor])),
  ),
  Layer.provideMerge(Layer.provideMerge(BeaconLive, withTempDb())),
)

const runtime = ManagedRuntime.make(TestLayer)
const runEffect: RunEffect = <A, E>(eff: Effect.Effect<A, E, Layer.Success<typeof TestLayer>>) =>
  runtime.runPromise(eff)
const app = makeApp({ apiToken: Redacted.make(TOKEN), runEffect })

const newBot = (name: string) =>
  Schema.decodeUnknownSync(NewBot)({
    name,
    role: "developer",
    kind: "auxiliary",
    instructions: "Do the work.",
    executors: { preferred: "claude-code", allowed: ["claude-code"] },
    modelTiers: {},
    connectors: [],
    budget: { tokens: 200000, seconds: 1800, usd: 2 },
    policy: "default",
    tank: { mode: "local", host: "mac" },
    memory: { scope: "bot" },
  })

let alpha: Bot
let beta: Bot

beforeAll(async () => {
  const bots = await runEffect(
    Effect.gen(function* () {
      const registry = yield* BotRegistry
      return [yield* registry.upsert(newBot("alpha"), "test"), yield* registry.upsert(newBot("beta"), "test")]
    }),
  )
  alpha = bots[0] as Bot
  beta = bots[1] as Bot
  runtime.runFork(
    Effect.gen(function* () {
      const lead = yield* Lead
      yield* lead.startWorker({ concurrency: 4, pollMs: 20 })
      return yield* Effect.never
    }).pipe(Effect.scoped),
  )
})

afterAll(async () => {
  await runtime.dispose()
  for (const pid of pids) {
    try {
      process.kill(-pid, "SIGKILL")
    } catch {
      // already gone
    }
  }
  rmSync(tankRoot, { recursive: true, force: true })
})

interface Json {
  readonly [key: string]: unknown
}
const json = async (res: Response): Promise<Json> => (await res.json()) as Json

const post = (path: string, body?: unknown) =>
  app.request(path, {
    method: "POST",
    headers: AUTH,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const createTask = async (bot: Bot, prompt: string): Promise<string> => {
  const res = await post("/tasks", {
    botId: bot.id,
    title: "t",
    prompt,
    kind: "chat",
    acceptance: [],
    budget: { tokens: 200000, seconds: 1800, usd: 2 },
    tier: "light",
    origin: "api",
  })
  expect(res.status).toBe(201)
  return String(((await json(res)).task as Json).id)
}

const stateOf = async (id: string): Promise<string> =>
  String((await json(await app.request(`/tasks/${id}`, { headers: AUTH }))).state)

const waitFor = async (check: () => Promise<boolean>, what: string): Promise<void> => {
  const deadline = Date.now() + 8000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

// kill(-pid, 0) throws ESRCH once no process of the group is left.
const groupAlive = (pid: number): boolean => {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

// The process group of the task's own run, once it exists (never another task's: pids are shared by the whole file).
const processOf = async (taskId: string): Promise<number> => {
  await waitFor(
    async () => pidOfTask.has(taskId) && (await stateOf(taskId)) === "running",
    "the task's process",
  )
  return pidOfTask.get(taskId) as number
}

const ledger = async (taskId: string): Promise<ReadonlyArray<number>> =>
  runEffect(
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const rows = yield* sql<{
        readonly pgid: number
      }>`SELECT pgid FROM task_processes WHERE task_id = ${taskId}`
      return rows.map((row) => row.pgid)
    }),
  )

describe("control routes", () => {
  // A test that fails halfway must not leave a running task behind for the next one.
  afterEach(async () => {
    await post("/control/stop")
  })

  it("records the process group of a run and forgets it when the run ends", async () => {
    const id = await createTask(beta, "hang ledger")
    const pid = await processOf(id)
    await waitFor(async () => (await ledger(id)).includes(pid), "the process group to be recorded")

    expect((await post(`/tasks/${id}/stop`)).status).toBe(200)

    expect(await ledger(id)).toEqual([])
    expect(groupAlive(pid)).toBe(false)
  })

  it("the watchdog stops a stuck task of this process through the same path, killing its processes", async () => {
    const id = await createTask(alpha, "hang watchdog")
    const pid = await processOf(id)
    // Out of attempts and silent for longer than the limit: the watchdog stops it instead of requeueing.
    await runEffect(
      Effect.gen(function* () {
        const sql = yield* SqlClient
        yield* sql`UPDATE tasks SET attempts = 2 WHERE id = ${id}`
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 60))

    await runEffect(runWatchdogCycle({ intervalMs: 300_000, staleMinutes: 0.0005, maxProcessMinutes: 45 }))

    expect(await stateOf(id)).toBe("cancelled")
    expect(groupAlive(pid)).toBe(false)
  })

  it("POST /tasks/:id/stop kills the Tank process group of a running task and cancels the task", async () => {
    const id = await createTask(alpha, "hang until stopped")
    const pid = await processOf(id)
    expect(groupAlive(pid)).toBe(true)

    const started = Date.now()
    const res = await post(`/tasks/${id}/stop`)

    expect(res.status).toBe(200)
    expect((await json(res)).stopped).toEqual([id])
    expect(groupAlive(pid)).toBe(false)
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(await stateOf(id)).toBe("cancelled")
  })

  it("POST /control/stop with a Bot cancels that Bot's running task, kills its processes, and pauses nothing", async () => {
    const mine = await createTask(alpha, "hang a")
    const other = await createTask(beta, "hang b")
    await waitFor(
      async () => (await stateOf(mine)) === "running" && (await stateOf(other)) === "running",
      "both tasks to run",
    )
    await waitFor(async () => pidOfTask.has(mine) && pidOfTask.has(other), "both processes to start")
    const minePid = pidOfTask.get(mine) as number
    const otherPid = pidOfTask.get(other) as number
    const res = await post("/control/stop", { bot: "alpha" })

    expect(res.status).toBe(200)
    const stopped = (await json(res)).stopped as ReadonlyArray<string>
    expect(stopped).toEqual([mine])
    expect(await stateOf(mine)).toBe("cancelled")
    expect(groupAlive(minePid)).toBe(false)
    expect(await stateOf(other)).toBe("running")
    expect(groupAlive(otherPid)).toBe(true)
    const status = await json(await app.request("/control/status", { headers: AUTH }))
    expect(status.paused).toBe(false)
    const rows = status.bots as ReadonlyArray<Json>
    expect(rows.find((bot) => bot.name === "alpha")).toMatchObject({ state: "idle", paused: false })
    expect(rows.find((bot) => bot.name === "beta")).toMatchObject({ state: "working", running: 1 })

    // A stop leaves nothing behind: the Bot takes new work right away, without a resume.
    const next = await createTask(alpha, "quick")
    await waitFor(async () => (await stateOf(next)) === "done", "new work after the stop")

    const all = await post("/control/stop")
    expect(all.status).toBe(200)
    expect(await stateOf(other)).toBe("cancelled")
    expect(groupAlive(otherPid)).toBe(false)
  })

  it("pauses and resumes everything", async () => {
    expect((await post("/control/pause")).status).toBe(200)
    const held = await createTask(beta, "quick")
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(await stateOf(held)).toBe("received")
    expect((await json(await app.request("/control/status", { headers: AUTH }))).paused).toBe(true)

    expect((await post("/control/resume")).status).toBe(200)
    await waitFor(async () => (await stateOf(held)) === "done", "the held task after resume")
  })

  it("answers 404 for an unknown Bot or task, 400 for a body that is not JSON, 401 without the token", async () => {
    expect((await post("/control/stop", { bot: "ghost" })).status).toBe(404)
    expect((await post("/tasks/task_00000000-0000-4000-8000-0000000000ff/stop")).status).toBe(404)
    expect((await post("/tasks/not-an-id/stop")).status).toBe(404)
    const broken = await app.request("/control/pause", { method: "POST", headers: AUTH, body: "{oops" })
    expect(broken.status).toBe(400)
    expect((await app.request("/control/stop", { method: "POST" })).status).toBe(401)
    expect((await app.request("/control/status")).status).toBe(401)
  })
})
