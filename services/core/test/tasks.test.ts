import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BeaconLive } from "@shoalwork/beacon"
import { BotRegistry, BotRegistryLive } from "@shoalwork/bots"
import { type Bot, NewBot } from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { makeRegistry } from "@shoalwork/executors"
import { LeadWithStore } from "@shoalwork/lead"
import { TankLocalLive } from "@shoalwork/tank"
import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { makeApp } from "../src/http/app.js"
import type { RunEffect } from "../src/http/routes/respond.js"
import { DEFAULT_TIERS } from "../src/model-tiers.js"

const TOKEN = "test-token"
const AUTH = { authorization: `Bearer ${TOKEN}` }

interface TaskBody {
  readonly task: {
    readonly id: string
    readonly botId: string
    readonly prompt: string
    readonly kind: string
  }
}
interface TaskViewBody {
  readonly spec: { readonly id: string; readonly botId: string }
  readonly state: string
  readonly verdict?: unknown
}
interface ErrorBody {
  readonly error: string
  readonly entity?: string
  readonly param?: string
  readonly where?: string
  readonly issues?: ReadonlyArray<unknown>
}
interface EventsBody {
  readonly events: ReadonlyArray<{
    readonly type: string
    readonly streamId: string
    readonly version: number
  }>
}

// Response bodies are checked by the assertions that follow each call, so the cast is confined to this helper.
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T

// Same wiring as the production AppLayer (Lead with its store, Beacon, bots, Tank, executors), minus the worker.
const tankRoot = mkdtempSync(join(tmpdir(), "shoalwork-tasks-tank-"))
const TestLayer = LeadWithStore(DEFAULT_TIERS).pipe(
  Layer.provideMerge(
    Layer.mergeAll(BotRegistryLive, TankLocalLive({ root: tankRoot, baseEnv: {} }), makeRegistry([])),
  ),
  Layer.provideMerge(Layer.provideMerge(BeaconLive, withTempDb())),
)

const runtime = ManagedRuntime.make(TestLayer)
const runEffect: RunEffect = (eff) => runtime.runPromise(eff)

const app = makeApp({ apiToken: Redacted.make(TOKEN), runEffect })

const NEW_BOT = Schema.decodeUnknownSync(NewBot)({
  name: "tasks-bot",
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
  bot = await runEffect(
    Effect.gen(function* () {
      const registry = yield* BotRegistry
      return yield* registry.upsert(NEW_BOT, "test")
    }),
  )
})

afterAll(async () => {
  await runtime.dispose()
  rmSync(tankRoot, { recursive: true, force: true })
})

const taskBody = (over: Record<string, unknown> = {}) => ({
  botId: bot.id,
  title: "Reply",
  prompt: "reply with the single word pong",
  kind: "chat",
  acceptance: [],
  budget: { tokens: 200000, seconds: 1800, usd: 2 },
  tier: "light",
  origin: "cli",
  ...over,
})

const postTask = (body: unknown) =>
  app.request("/tasks", {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify(body),
  })

const createdTaskId = async (): Promise<string> => {
  const res = await postTask(taskBody())
  expect(res.status).toBe(201)
  const body = await json<TaskBody>(res)
  return body.task.id
}

describe("POST /tasks", () => {
  it("accepts a valid spec, assigns an id and answers 201 with the task", async () => {
    const res = await postTask(taskBody())

    expect(res.status).toBe(201)
    const body = await json<TaskBody>(res)
    expect(body.task).toMatchObject({
      botId: bot.id,
      prompt: "reply with the single word pong",
      kind: "chat",
    })
    expect(body.task.id).toMatch(/^task_[0-9a-f-]{36}$/)
  })

  it("rejects a body without a prompt with 400 and the schema issues", async () => {
    const { prompt: _omitted, ...withoutPrompt } = taskBody()
    const res = await postTask(withoutPrompt)

    expect(res.status).toBe(400)
    const body = await json<ErrorBody>(res)
    expect(body.error).toBe("invalid request")
    expect(Array.isArray(body.issues)).toBe(true)
    expect(body.issues?.length).toBeGreaterThan(0)
  })

  it("rejects a body with an unknown kind with 400", async () => {
    const res = await postTask(taskBody({ kind: "nonsense" }))

    expect(res.status).toBe(400)
  })

  it("rejects unreadable JSON with 400", async () => {
    const res = await app.request("/tasks", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: "{not json",
    })

    expect(res.status).toBe(400)
  })

  it("answers 404 for a bot id that is not registered", async () => {
    const res = await postTask(taskBody({ botId: "bot_00000000-0000-4000-8000-000000000000" }))

    expect(res.status).toBe(404)
    expect(await json<ErrorBody>(res)).toMatchObject({ error: "not found", entity: "Bot" })
  })

  it("requires the bearer token", async () => {
    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(taskBody()),
    })

    expect(res.status).toBe(401)
  })
})

describe("GET /tasks/:id", () => {
  it("returns the spec and the state of a task just received", async () => {
    const id = await createdTaskId()

    const res = await app.request(`/tasks/${id}`, { headers: AUTH })

    expect(res.status).toBe(200)
    const body = await json<TaskViewBody>(res)
    expect(body).toMatchObject({ spec: { id, botId: bot.id }, state: "received" })
    expect(body.verdict).toBeUndefined()
  })

  it("answers 404 for an id that is well formed but unknown", async () => {
    const res = await app.request("/tasks/task_00000000-0000-4000-8000-000000000000", { headers: AUTH })

    expect(res.status).toBe(404)
    expect(await json<ErrorBody>(res)).toMatchObject({ error: "not found", entity: "Task" })
  })

  it("answers 404 for a malformed id", async () => {
    const res = await app.request("/tasks/not-a-task-id", { headers: AUTH })

    expect(res.status).toBe(404)
  })
})

interface BotsBody {
  readonly bots: ReadonlyArray<{ readonly id: string; readonly name: string; readonly state: string }>
  readonly bot?: { readonly id: string; readonly name: string; readonly state: string }
}

describe("GET /bots", () => {
  it("lists the registered bots with their id, name, role and state", async () => {
    const res = await app.request("/bots", { headers: AUTH })

    expect(res.status).toBe(200)
    const body = await json<BotsBody>(res)
    expect(body.bots).toContainEqual(
      expect.objectContaining({ id: bot.id, name: "tasks-bot", state: "idle" }),
    )
  })

  it("reads one bot by name and by id", async () => {
    const byName = await json<BotsBody>(await app.request("/bots/tasks-bot", { headers: AUTH }))
    const byId = await json<BotsBody>(await app.request(`/bots/${bot.id}`, { headers: AUTH }))

    expect(byName.bot).toMatchObject({ id: bot.id, name: "tasks-bot" })
    expect(byId.bot).toMatchObject({ id: bot.id, name: "tasks-bot" })
  })

  it("answers 404 for an unknown bot name", async () => {
    const res = await app.request("/bots/ghost", { headers: AUTH })

    expect(res.status).toBe(404)
    expect(await json<ErrorBody>(res)).toMatchObject({ error: "not found", entity: "Bot", id: "ghost" })
  })

  it("requires the bearer token", async () => {
    const res = await app.request("/bots")

    expect(res.status).toBe(401)
  })
})

describe("GET /events", () => {
  it("returns the events of a task stream", async () => {
    const id = await createdTaskId()

    const res = await app.request(`/events?stream=task:${id}`, { headers: AUTH })

    expect(res.status).toBe(200)
    const body = await json<EventsBody>(res)
    expect(body.events).toHaveLength(1)
    expect(body.events[0]).toMatchObject({ streamId: `task:${id}`, type: "task.received", version: 1 })
  })

  it("filters by event type with ?types=", async () => {
    const id = await createdTaskId()

    const matching = await json<EventsBody>(
      await app.request(`/events?stream=task:${id}&types=task.received`, { headers: AUTH }),
    )
    const other = await json<EventsBody>(
      await app.request(`/events?stream=task:${id}&types=task.state_changed,budget.exceeded`, {
        headers: AUTH,
      }),
    )

    expect(matching.events.map((event) => event.type)).toEqual(["task.received"])
    expect(other.events).toEqual([])
  })

  it("starts after the given version with ?after=", async () => {
    const id = await createdTaskId()

    const body = await json<EventsBody>(
      await app.request(`/events?stream=task:${id}&after=1`, { headers: AUTH }),
    )

    expect(body.events).toEqual([])
  })

  it("rejects a request without stream with 400", async () => {
    const res = await app.request("/events", { headers: AUTH })

    expect(res.status).toBe(400)
    expect(await json<ErrorBody>(res)).toEqual({ error: "invalid query", param: "stream" })
  })

  it("rejects an unknown event type with 400", async () => {
    const id = await createdTaskId()

    const res = await app.request(`/events?stream=task:${id}&types=task.received,made.up`, { headers: AUTH })

    expect(res.status).toBe(400)
    expect(await json<ErrorBody>(res)).toEqual({ error: "invalid query", param: "types" })
  })

  it("rejects a negative or non-numeric after with 400", async () => {
    const res = await app.request("/events?stream=system&after=-1", { headers: AUTH })

    expect(res.status).toBe(400)
    expect(await json<ErrorBody>(res)).toEqual({ error: "invalid query", param: "after" })
  })
})
