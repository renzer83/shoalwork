import { BeaconLive } from "@shoalwork/beacon"
import { BotRegistry, BotRegistryLive } from "@shoalwork/bots"
import { NewBot } from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { makeApp } from "../src/http/app.js"
import type { RunEffect } from "../src/http/routes/respond.js"

const TOKEN = "test-token"
const AUTH = { authorization: `Bearer ${TOKEN}` }

const TestLayer = BotRegistryLive.pipe(Layer.provideMerge(Layer.provideMerge(BeaconLive, withTempDb())))
const runtime = ManagedRuntime.make(TestLayer)
const runEffect: RunEffect = <A, E>(eff: Effect.Effect<A, E, Layer.Success<typeof TestLayer>>) =>
  runtime.runPromise(eff)

const app = makeApp({ apiToken: Redacted.make(TOKEN), runEffect })

const NEW_BOT = Schema.decodeUnknownSync(NewBot)({
  name: "ficha-bot",
  role: "reviewer",
  kind: "auxiliary",
  instructions: "Review the diff and answer briefly.",
  executors: { preferred: "claude-code", allowed: ["claude-code", "codex"] },
  modelTiers: {},
  connectors: ["telegram"],
  budget: { tokens: 300000, seconds: 900, usd: 3 },
  policy: "default",
  tank: { mode: "local", host: "mac" },
  memory: { scope: "bot" },
})

beforeAll(async () => {
  await runEffect(
    Effect.gen(function* () {
      const registry = yield* BotRegistry
      return yield* registry.upsert(NEW_BOT, "test")
    }),
  )
})

afterAll(async () => {
  await runtime.dispose()
})

interface BotBody {
  readonly bot: {
    readonly id: string
    readonly name: string
    readonly role: string
    readonly instructions: string
    readonly state: string
    readonly executors: { readonly preferred: string; readonly allowed: ReadonlyArray<string> }
    readonly connectors: ReadonlyArray<string>
    readonly budget: { readonly tokens: number; readonly seconds: number; readonly usd: number }
    readonly tank: { readonly mode: string; readonly host: string }
    readonly memory: { readonly scope: string }
  }
}

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T

describe("GET /bots/:idOrName returns the full definition", () => {
  it("answers the ficha fields and the live state by name", async () => {
    const res = await app.request("/bots/ficha-bot", { headers: AUTH })

    expect(res.status).toBe(200)
    const { bot } = await json<BotBody>(res)
    expect(bot).toMatchObject({
      name: "ficha-bot",
      role: "reviewer",
      instructions: "Review the diff and answer briefly.",
      state: "idle",
      executors: { preferred: "claude-code", allowed: ["claude-code", "codex"] },
      connectors: ["telegram"],
      budget: { tokens: 300000, seconds: 900, usd: 3 },
      tank: { mode: "local", host: "mac" },
      memory: { scope: "bot" },
    })
  })

  it("answers the same definition by id", async () => {
    const byName = await json<BotBody>(await app.request("/bots/ficha-bot", { headers: AUTH }))
    const byId = await json<BotBody>(await app.request(`/bots/${byName.bot.id}`, { headers: AUTH }))

    expect(byId.bot).toEqual(byName.bot)
  })

  it("answers 404 for an unknown bot", async () => {
    const res = await app.request("/bots/ghost-bot", { headers: AUTH })

    expect(res.status).toBe(404)
  })
})
