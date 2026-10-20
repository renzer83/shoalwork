import { randomUUID } from "node:crypto"
import { it } from "@effect/vitest"
import { Beacon } from "@shoalwork/beacon"
import { BotRegistry } from "@shoalwork/bots"
import { type BotId, type Event, streamIds, type Tide } from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect, Option, Stream } from "effect"
import { describe, expect } from "vitest"
import { Tides } from "../src/index.js"
import { type Intake, NEW_BOT, TEMPLATE, tidesEnv } from "./support.js"

const DAY_MS = 24 * 60 * 60 * 1000
const REPO = "renzer83/shoalwork"

const registerBot = Effect.gen(function* () {
  const registry = yield* BotRegistry
  return yield* registry.upsert(NEW_BOT, "test")
})

const cronTide = (botId: BotId, overrides: Partial<Omit<Tide, "id">> = {}): Omit<Tide, "id"> => ({
  botId,
  name: "every-minute",
  kind: "cron",
  cronExpr: "* * * * *",
  timezone: "UTC",
  cooldownSeconds: 60,
  maxFiresPerHour: 30,
  taskTemplate: TEMPLATE,
  enabled: true,
  ...overrides,
})

const eventsOf = (type: Event["type"]) =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    return yield* Stream.runCollect(beacon.readAll(0, [type]))
  })

// A push from a Bot's own branch (botAuthored) or from a person: the body is the GitHub event payload (T-045).
const githubPush = (botAuthored: boolean): Parameters<Beacon["Service"]["append"]>[0] => ({
  streamId: streamIds.system,
  type: "github.push",
  payload: {
    deliveryId: randomUUID(),
    repo: REPO,
    action: "pushed",
    sender: "renzer83",
    url: `https://github.com/${REPO}/commits/main`,
    botAuthored,
    ref: "refs/heads/main",
  },
  actor: "system:github",
  correlationId: randomUUID(),
})

describe("tide.skipped for the skips that were silent", () => {
  it.effect("a cooldown held back once per hour writes one tide.skipped with reason cooldown", () => {
    const intakes: Array<Intake> = []
    const env = tidesEnv(withTempDb(), intakes, { botBudgetWindowMs: DAY_MS })
    return Effect.gen(function* () {
      const bot = yield* registerBot
      const tides = yield* Tides
      const tide = yield* tides.upsert(cronTide(bot.id))
      yield* tides.runNow(tide.id)
      expect(yield* Effect.flip(tides.runNow(tide.id))).toMatchObject({ reason: "cooldown" })
      expect(yield* Effect.flip(tides.runNow(tide.id))).toMatchObject({ reason: "cooldown" })
      const skipped = yield* eventsOf("tide.skipped")
      expect(skipped).toHaveLength(1)
      expect(skipped[0]?.payload).toEqual({ tideId: tide.id, botId: bot.id, reason: "cooldown" })
      expect(intakes).toHaveLength(1)
    }).pipe(Effect.provide(env))
  })

  it.effect("the hourly cap held back writes one tide.skipped with reason cap", () => {
    const intakes: Array<Intake> = []
    const env = tidesEnv(withTempDb(), intakes, { botBudgetWindowMs: DAY_MS })
    return Effect.gen(function* () {
      const bot = yield* registerBot
      const tides = yield* Tides
      const tide = yield* tides.upsert(cronTide(bot.id, { cooldownSeconds: 0, maxFiresPerHour: 1 }))
      yield* tides.runNow(tide.id)
      expect(yield* Effect.flip(tides.runNow(tide.id))).toMatchObject({ reason: "rate" })
      expect(yield* Effect.flip(tides.runNow(tide.id))).toMatchObject({ reason: "rate" })
      const skipped = yield* eventsOf("tide.skipped")
      expect(skipped).toHaveLength(1)
      expect(skipped[0]?.payload).toMatchObject({ tideId: tide.id, reason: "cap" })
    }).pipe(Effect.provide(env))
  })

  it.effect("a firing asked of a disabled Tide is refused as NotFound and writes reason disabled", () => {
    const intakes: Array<Intake> = []
    const env = tidesEnv(withTempDb(), intakes, { botBudgetWindowMs: DAY_MS })
    return Effect.gen(function* () {
      const bot = yield* registerBot
      const tides = yield* Tides
      const tide = yield* tides.upsert(cronTide(bot.id, { enabled: false }))
      expect(yield* Effect.flip(tides.fireFromWebhook(tide.id, { ok: true }))).toMatchObject({
        _tag: "NotFound",
      })
      expect(yield* Effect.flip(tides.fireFromWebhook(tide.id, { ok: true }))).toMatchObject({
        _tag: "NotFound",
      })
      const skipped = yield* eventsOf("tide.skipped")
      expect(skipped).toHaveLength(1)
      expect(skipped[0]?.payload).toMatchObject({ tideId: tide.id, reason: "disabled" })
      expect(intakes).toHaveLength(0)
    }).pipe(Effect.provide(env))
  })

  it.live(
    "a Bot's own push that the event tide did not opt in is held back as feedback, and nothing fires",
    () => {
      const intakes: Array<Intake> = []
      const env = tidesEnv(withTempDb(), intakes, { botBudgetWindowMs: DAY_MS })
      return Effect.scoped(
        Effect.gen(function* () {
          const bot = yield* registerBot
          const tides = yield* Tides
          const beacon = yield* Beacon
          const tide = yield* tides.upsert({
            ...cronTide(bot.id),
            kind: "event",
            cronExpr: undefined,
            name: "on-push",
            eventType: "github.push",
            eventFilter: { "payload.repo": REPO },
          })
          const skipped = yield* beacon.subscribe(["tide.skipped"])
          yield* tides.startScheduler({ pollMs: 60_000 })
          yield* beacon.append(githubPush(true))
          const first = yield* Stream.runHead(skipped)
          expect(Option.isSome(first)).toBe(true)
          expect(first.pipe(Option.map((event) => event.payload))).toEqual(
            Option.some({ tideId: tide.id, botId: bot.id, reason: "feedback" }),
          )
          expect(intakes).toHaveLength(0)
          expect(yield* eventsOf("tide.fired")).toHaveLength(0)
        }).pipe(Effect.provide(env)),
      )
    },
  )
})

describe("manual trigger", () => {
  it.effect("a run-now records tide.fired with trigger manual, not the kind of the Tide", () => {
    const intakes: Array<Intake> = []
    const env = tidesEnv(withTempDb(), intakes, { botBudgetWindowMs: DAY_MS })
    return Effect.gen(function* () {
      const bot = yield* registerBot
      const tides = yield* Tides
      const tide = yield* tides.upsert(cronTide(bot.id))
      const spec = yield* tides.runNow(tide.id)
      const fired = yield* eventsOf("tide.fired")
      expect(fired[0]?.payload).toMatchObject({ tideId: tide.id, trigger: "manual", taskId: spec.id })
    }).pipe(Effect.provide(env))
  })
})
