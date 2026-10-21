import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { Beacon } from "@shoalwork/beacon"
import { BotRegistry } from "@shoalwork/bots"
import { EventPayloads, NewBot, streamIds } from "@shoalwork/contracts"
import { runMigrations } from "@shoalwork/db"
import { Conversation } from "@shoalwork/lead"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import { afterAll, beforeAll, describe, expect } from "vitest"
import { AppLayer } from "../src/runtime.js"

const decodeOutbound = Schema.decodeUnknownOption(EventPayloads["message.outbound"])

const lead = Schema.decodeUnknownSync(NewBot)({
  name: "lead",
  role: "coordinator",
  kind: "fixed",
  instructions: "You are lead.",
  executors: { preferred: "claude-code", allowed: ["claude-code"] },
  modelTiers: {},
  connectors: [],
  budget: { tokens: 500000, seconds: 1800, usd: 5 },
  policy: "default",
  tank: { mode: "local", host: "mac" },
  memory: { scope: "bot" },
})

// The core with Telegram off still answers the app channel: the conversation runs and writes message.outbound.
describe("app channel in the core (Telegram off)", () => {
  const dir = mkdtempSync(join(tmpdir(), "shoalwork-core-app-"))
  const saved: Record<string, string | undefined> = {}
  const overrides: Record<string, string> = {
    API_TOKEN: "t",
    DATABASE_PATH: join(dir, "app.db"),
    TANK_ROOT: join(dir, "tank"),
    TELEGRAM_BOT_TOKEN: "",
    OLLAMA_URL: "http://127.0.0.1:1",
  }
  beforeAll(() => {
    for (const [key, value] of Object.entries(overrides)) {
      saved[key] = process.env[key]
      process.env[key] = value
    }
  })
  afterAll(() => {
    for (const key of Object.keys(overrides)) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it.live(
    "answers /help from the app as message.outbound{channel:app} on the Bot's stream",
    () =>
      Effect.gen(function* () {
        const context = yield* Layer.build(AppLayer)
        yield* Effect.gen(function* () {
          yield* runMigrations
          const bots = yield* BotRegistry
          const beacon = yield* Beacon
          const bot = yield* bots.upsert(lead, "test")
          yield* (yield* Conversation).start
          // Subscribed before the message is recorded, so the reply cannot be missed; no sleeps, only a generous bound.
          const outbound = yield* beacon.subscribe(["message.outbound"])
          const inbound = yield* beacon.append({
            streamId: streamIds.bot(bot.id),
            type: "message.inbound",
            payload: { channel: "app", userId: "user:app", text: "/help", botId: bot.id },
            actor: "user:app",
            correlationId: crypto.randomUUID(),
          })
          const first = yield* Stream.runHead(outbound).pipe(Effect.timeout("25 seconds"))
          const reply = Option.getOrUndefined(first)
          expect(reply).toBeDefined()
          const payload = decodeOutbound(reply?.payload)
          expect(Option.isSome(payload) ? payload.value : undefined).toMatchObject({
            channel: "app",
            botId: bot.id,
            inReplyTo: inbound.id,
          })
          expect(reply?.correlationId).toBe(inbound.correlationId)
        }).pipe(Effect.provide(context))
      }).pipe(Effect.scoped),
    30_000,
  )
})
