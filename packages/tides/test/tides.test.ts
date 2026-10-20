import { randomUUID } from "node:crypto"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { Beacon } from "@shoalwork/beacon"
import { BotRegistry } from "@shoalwork/bots"
import { type BotId, type Event, SchemaViolation, streamIds, type Tide } from "@shoalwork/contracts"
import { makeDbLayer, runMigrations } from "@shoalwork/db"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect, Stream } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { TideSkipped, Tides } from "../src/index.js"
import { type Intake, NEW_BOT, TEMPLATE, tidesEnv } from "./support.js"

const DAY_MS = 24 * 60 * 60 * 1000
const MINUTE_MS = 60_000
const TASK = "task_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"

// A clock the test moves by hand. Starts at the real time so events stamped by the database fall in the budget window.
const makeClock = () => {
  let current = new Date()
  return {
    now: () => current,
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms)
    },
  }
}

const cronTide = (botId: BotId, expr = "* * * * *"): Omit<Tide, "id"> => ({
  botId,
  name: "every-minute",
  kind: "cron",
  cronExpr: expr,
  timezone: "UTC",
  cooldownSeconds: 60,
  maxFiresPerHour: 30,
  taskTemplate: TEMPLATE,
  enabled: true,
})

const eventTide = (
  botId: BotId,
  name: string,
  eventType: Tide["eventType"],
  filter: Record<string, string>,
  title: string = TEMPLATE.title,
): Omit<Tide, "id"> => ({
  botId,
  name,
  kind: "event",
  eventType,
  eventFilter: filter,
  timezone: "UTC",
  cooldownSeconds: 60,
  maxFiresPerHour: 30,
  taskTemplate: { ...TEMPLATE, title },
  enabled: true,
})

const registerBot = Effect.gen(function* () {
  const registry = yield* BotRegistry
  return yield* registry.upsert(NEW_BOT, "test")
})

// Runs the scheduler loop for a moment, the way the core does, then stops it with the scope.
const runScheduler = (pollMs: number, millis: number) =>
  Effect.gen(function* () {
    const tides = yield* Tides
    yield* tides.startScheduler({ pollMs })
    yield* Effect.sleep(`${millis} millis`)
  }).pipe(Effect.scoped)

const eventsOf = (type: Event["type"]) =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    return yield* Stream.runCollect(beacon.readAll(0, [type]))
  })

// The tide id a tide.fired event names, read without a cast.
const firedTideId = (event: Event): string | undefined => {
  const payload = event.payload
  return typeof payload === "object" && payload !== null && "tideId" in payload
    ? String(payload.tideId)
    : undefined
}

const removeDbFiles = (path: string): void => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${path}${suffix}`, { force: true })
  }
}

describe("Tides", () => {
  it.effect("a second upsert of the same cron tide keeps its id and its next run", () => {
    const intakes: Array<Intake> = []
    const clock = makeClock()
    const env = tidesEnv(withTempDb(), intakes, { botBudgetWindowMs: DAY_MS, clock: clock.now })
    return Effect.gen(function* () {
      const bot = yield* registerBot
      const tides = yield* Tides
      const first = yield* tides.upsert(cronTide(bot.id))
      const sql = yield* SqlClient
      const [before] = yield* sql<{
        readonly next_run_at: string
      }>`SELECT next_run_at FROM tides WHERE id = ${first.id}`
      clock.advance(30_000)
      const second = yield* tides.upsert(cronTide(bot.id))
      const [after] = yield* sql<{
        readonly next_run_at: string
      }>`SELECT next_run_at FROM tides WHERE id = ${first.id}`
      expect(second.id).toBe(first.id)
      expect(yield* tides.list(bot.id)).toHaveLength(1)
      expect(after?.next_run_at).toBe(before?.next_run_at)
    }).pipe(Effect.provide(env))
  })

  it.effect("refuses a cron expression that never runs, with SchemaViolation", () => {
    const intakes: Array<Intake> = []
    const env = tidesEnv(withTempDb(), intakes, { botBudgetWindowMs: DAY_MS })
    return Effect.gen(function* () {
      const bot = yield* registerBot
      const tides = yield* Tides
      const error = yield* Effect.flip(tides.upsert(cronTide(bot.id, "not a cron")))
      expect(error).toBeInstanceOf(SchemaViolation)
      expect(yield* tides.list(bot.id)).toHaveLength(0)
    }).pipe(Effect.provide(env))
  })

  it.live("a due cron window fires exactly once with two schedulers on two connections", () => {
    const path = join(tmpdir(), `shoalwork-tides-${randomUUID()}.db`)
    const intakes: Array<Intake> = []
    const clock = makeClock()
    const options = { botBudgetWindowMs: DAY_MS, clock: clock.now }
    const first = tidesEnv(makeDbLayer(path), intakes, options)
    const second = tidesEnv(makeDbLayer(path), intakes, options)
    return Effect.gen(function* () {
      yield* runMigrations.pipe(Effect.provide(makeDbLayer(path)))
      const bot = yield* registerBot.pipe(Effect.provide(first))
      yield* Tides.pipe(
        Effect.flatMap((tides) => tides.upsert(cronTide(bot.id))),
        Effect.provide(first),
      )
      clock.advance(2 * MINUTE_MS)
      yield* Effect.all(
        [runScheduler(5, 300).pipe(Effect.provide(first)), runScheduler(5, 300).pipe(Effect.provide(second))],
        { concurrency: "unbounded" },
      )
      expect(intakes).toHaveLength(1)
      expect(yield* eventsOf("tide.fired").pipe(Effect.provide(first))).toHaveLength(1)
    }).pipe(Effect.ensuring(Effect.sync(() => removeDbFiles(path))))
  })

  it.live("a cron that becomes unrunnable disables the tide and records error.raised", () => {
    const intakes: Array<Intake> = []
    const clock = makeClock()
    const env = tidesEnv(withTempDb(), intakes, { botBudgetWindowMs: DAY_MS, clock: clock.now })
    return Effect.gen(function* () {
      const bot = yield* registerBot
      const tides = yield* Tides
      const tide = yield* tides.upsert(cronTide(bot.id))
      const sql = yield* SqlClient
      yield* sql`UPDATE tides SET cron_expr = 'nonsense' WHERE id = ${tide.id}`
      clock.advance(2 * MINUTE_MS)
      yield* runScheduler(5, 100)
      const [stored] = yield* tides.list(bot.id)
      expect(stored?.enabled).toBe(false)
      expect(intakes).toHaveLength(0)
      const raised = yield* eventsOf("error.raised")
      expect(raised.some((event) => JSON.stringify(event.payload).includes("ScheduleBroken"))).toBe(true)
    }).pipe(Effect.provide(env))
  })

  it.effect("a paused Bot gets no task: runNow is refused and the reason is an event", () => {
    const intakes: Array<Intake> = []
    const env = tidesEnv(withTempDb(), intakes, { botBudgetWindowMs: DAY_MS })
    return Effect.gen(function* () {
      const bot = yield* registerBot
      const tides = yield* Tides
      const tide = yield* tides.upsert(cronTide(bot.id))
      const sql = yield* SqlClient
      yield* sql`INSERT INTO control_flags (scope, paused, updated_at) VALUES (${`bot:${bot.id}`}, 1, ${new Date().toISOString()})`
      const error = yield* Effect.flip(tides.runNow(tide.id))
      expect(error).toBeInstanceOf(TideSkipped)
      expect(error).toMatchObject({ reason: "paused" })
      expect(intakes).toHaveLength(0)
      const raised = yield* eventsOf("error.raised")
      expect(raised.some((event) => JSON.stringify(event.payload).includes("BotPaused"))).toBe(true)
    }).pipe(Effect.provide(env))
  })

  it.effect("an over-budget Bot gets no task: the reason is a budget.exceeded event", () => {
    const intakes: Array<Intake> = []
    const env = tidesEnv(withTempDb(), intakes, { botBudgetWindowMs: DAY_MS })
    return Effect.gen(function* () {
      const bot = yield* registerBot
      const tides = yield* Tides
      const tide = yield* tides.upsert(cronTide(bot.id))
      const beacon = yield* Beacon
      yield* beacon.append({
        streamId: streamIds.system,
        type: "usage.recorded",
        payload: {
          taskId: TASK,
          botId: bot.id,
          executor: "claude-code",
          model: "haiku",
          usage: { tokensIn: 2000, tokensOut: 0, cacheRead: 0, cacheWrite: 0, usd: 0, seconds: 1 },
        },
        actor: "system:test",
        correlationId: "corr_budget",
      })
      const error = yield* Effect.flip(tides.runNow(tide.id))
      expect(error).toMatchObject({ reason: "budget" })
      expect(intakes).toHaveLength(0)
      expect(yield* eventsOf("budget.exceeded")).toHaveLength(1)
    }).pipe(Effect.provide(env))
  })

  it.effect(
    "runNow returns the task of the template with origin tide and records tide.fired with trigger manual",
    () => {
      const intakes: Array<Intake> = []
      const env = tidesEnv(withTempDb(), intakes, { botBudgetWindowMs: DAY_MS })
      return Effect.gen(function* () {
        const bot = yield* registerBot
        const tides = yield* Tides
        const tide = yield* tides.upsert(cronTide(bot.id))
        const spec = yield* tides.runNow(tide.id)
        expect(spec.origin).toBe("tide")
        expect(spec.title).toBe(TEMPLATE.title)
        expect(intakes).toHaveLength(1)
        const fired = yield* eventsOf("tide.fired")
        expect(fired).toHaveLength(1)
        expect(fired[0]?.payload).toMatchObject({
          tideId: tide.id,
          botId: bot.id,
          trigger: "manual",
          taskId: spec.id,
        })
      }).pipe(Effect.provide(env))
    },
  )

  it.live("an event tide fires on a matching event only; the test waits on tide.fired, not on time", () => {
    const intakes: Array<Intake> = []
    const clock = makeClock()
    const env = tidesEnv(withTempDb(), intakes, { botBudgetWindowMs: DAY_MS, clock: clock.now })
    return Effect.scoped(
      Effect.gen(function* () {
        const bot = yield* registerBot
        const tides = yield* Tides
        const beacon = yield* Beacon
        yield* tides.upsert({
          ...eventTide(
            bot.id,
            "on-api-message",
            "message.inbound",
            { "payload.channel": "api", "payload.userId": "renan" },
            "Reply {{payload.userId}}",
          ),
          taskTemplate: {
            ...TEMPLATE,
            title: "Reply {{payload.userId}}",
            prompt: "Answer: {{payload.text}}",
          },
        })
        const sentinel = yield* tides.upsert(
          eventTide(bot.id, "sentinel", "message.inbound", { "payload.userId": "sentinel" }, "sentinel"),
        )
        const fired = yield* beacon.subscribe(["tide.fired"])
        yield* tides.startScheduler({ pollMs: 60_000 })
        const inbound = (channel: string, text: string): Parameters<typeof beacon.append>[0] => ({
          streamId: streamIds.system,
          type: "message.inbound",
          payload: { channel, userId: "renan", text },
          actor: "user:renan",
          correlationId: "corr_event_tide",
        })
        yield* beacon.append(inbound("telegram", "ignored"))
        yield* beacon.append(inbound("api", 'say "hi"\nnow'))
        yield* beacon.append({
          ...inbound("cli", "done"),
          payload: { channel: "cli", userId: "sentinel", text: "done" },
        })
        yield* Stream.runHead(Stream.filter(fired, (event) => firedTideId(event) === sentinel.id))
        const fromApi = intakes.filter((intake) => intake.title !== "sentinel")
        expect(fromApi).toHaveLength(1)
        expect(fromApi[0]?.title).toBe('Reply "renan"')
        expect(fromApi[0]?.prompt).toBe('Answer: "say \\"hi\\"\\nnow"')
        expect(fromApi[0]?.correlationId).toBe("corr_event_tide")
      }).pipe(Effect.provide(env)),
    )
  })

  it.live(
    "a tide on error.raised fires once for one error; its own skip records do not trigger it again",
    () => {
      const intakes: Array<Intake> = []
      const clock = makeClock()
      const env = tidesEnv(withTempDb(), intakes, { botBudgetWindowMs: DAY_MS, clock: clock.now })
      return Effect.scoped(
        Effect.gen(function* () {
          const bot = yield* registerBot
          const registry = yield* BotRegistry
          const tides = yield* Tides
          const beacon = yield* Beacon
          yield* tides.upsert(
            eventTide(bot.id, "on-error", "error.raised", { "payload.where": "tides.fire" }, "on-error"),
          )
          // The sentinel lives on a second Bot: a pause of the first one must not hold the sentinel back too.
          const watcher = yield* registry.upsert({ ...NEW_BOT, name: "watcher" }, "test")
          const sentinel = yield* tides.upsert(
            eventTide(
              watcher.id,
              "sentinel",
              "message.inbound",
              { "payload.userId": "sentinel" },
              "sentinel",
            ),
          )
          const sql = yield* SqlClient
          yield* sql`INSERT INTO control_flags (scope, paused, updated_at) VALUES (${`bot:${bot.id}`}, 1, ${new Date().toISOString()})`
          const fired = yield* beacon.subscribe(["tide.fired"])
          yield* tides.startScheduler({ pollMs: 60_000 })
          const raised = (): Parameters<typeof beacon.append>[0] => ({
            streamId: streamIds.system,
            type: "error.raised",
            payload: { where: "tides.fire", tag: "Probe", message: "probe" },
            actor: "user:renan",
            correlationId: "corr_loop",
          })
          yield* beacon.append(raised())
          yield* beacon.append(raised())
          yield* beacon.append({
            streamId: streamIds.system,
            type: "message.inbound",
            payload: { channel: "cli", userId: "sentinel", text: "done" },
            actor: "user:renan",
            correlationId: "corr_loop",
          })
          yield* Stream.runHead(Stream.filter(fired, (event) => firedTideId(event) === sentinel.id))
          expect(intakes.filter((intake) => intake.title !== "sentinel")).toHaveLength(0)
          const botPaused = (yield* eventsOf("error.raised")).filter((event) =>
            JSON.stringify(event.payload).includes("BotPaused"),
          )
          expect(botPaused).toHaveLength(1)
        }).pipe(Effect.provide(env)),
      )
    },
  )

  it.live("a tide on task.state_changed to failed does not fire more than once per cooldown", () => {
    const intakes: Array<Intake> = []
    const clock = makeClock()
    const env = tidesEnv(withTempDb(), intakes, { botBudgetWindowMs: DAY_MS, clock: clock.now })
    return Effect.scoped(
      Effect.gen(function* () {
        const bot = yield* registerBot
        const tides = yield* Tides
        const beacon = yield* Beacon
        yield* tides.upsert(
          eventTide(bot.id, "on-failure", "task.state_changed", { "payload.to": "failed" }, "on-failure"),
        )
        const sentinel = yield* tides.upsert(
          eventTide(bot.id, "sentinel", "message.inbound", { "payload.userId": "sentinel" }, "sentinel"),
        )
        const fired = yield* beacon.subscribe(["tide.fired"])
        yield* tides.startScheduler({ pollMs: 60_000 })
        for (let attempt = 0; attempt < 5; attempt++) {
          yield* beacon.append({
            streamId: streamIds.system,
            type: "task.state_changed",
            payload: { taskId: TASK, from: "running", to: "failed" },
            actor: "system:lead",
            correlationId: TASK,
          })
        }
        yield* beacon.append({
          streamId: streamIds.system,
          type: "message.inbound",
          payload: { channel: "cli", userId: "sentinel", text: "done" },
          actor: "user:renan",
          correlationId: "corr_cooldown",
        })
        yield* Stream.runHead(Stream.filter(fired, (event) => firedTideId(event) === sentinel.id))
        expect(intakes.filter((intake) => intake.title !== "sentinel")).toHaveLength(1)
        const cooldown = (yield* eventsOf("error.raised")).filter((event) =>
          JSON.stringify(event.payload).includes("Cooldown"),
        )
        expect(cooldown).toHaveLength(1)
      }).pipe(Effect.provide(env)),
    )
  })

  it.effect("a broken stored tide is disabled alone and the other due tide still fires", () => {
    const intakes: Array<Intake> = []
    const clock = makeClock()
    const env = tidesEnv(withTempDb(), intakes, { botBudgetWindowMs: DAY_MS, clock: clock.now })
    return Effect.gen(function* () {
      const bot = yield* registerBot
      const tides = yield* Tides
      yield* tides.upsert({ ...cronTide(bot.id), name: "broken" })
      yield* tides.upsert({ ...cronTide(bot.id), name: "healthy" })
      const sql = yield* SqlClient
      yield* sql`UPDATE tides SET task_template = '{not json' WHERE name = 'broken'`
      clock.advance(2 * MINUTE_MS)
      yield* tides.tick()
      expect(intakes).toHaveLength(1)
      const [broken] = yield* sql<{
        readonly enabled: number
      }>`SELECT enabled FROM tides WHERE name = 'broken'`
      const [healthy] = yield* sql<{
        readonly enabled: number
      }>`SELECT enabled FROM tides WHERE name = 'healthy'`
      expect(broken?.enabled).toBe(0)
      expect(healthy?.enabled).toBe(1)
      const raised = yield* eventsOf("error.raised")
      expect(raised.some((event) => JSON.stringify(event.payload).includes("BrokenTide"))).toBe(true)
    }).pipe(Effect.provide(env))
  })

  it.effect("the hourly limit lets the first firings through and records one RateLimited line", () => {
    const intakes: Array<Intake> = []
    const env = tidesEnv(withTempDb(), intakes, { botBudgetWindowMs: DAY_MS })
    return Effect.gen(function* () {
      const bot = yield* registerBot
      const tides = yield* Tides
      const tide = yield* tides.upsert({ ...cronTide(bot.id), cooldownSeconds: 0, maxFiresPerHour: 1 })
      yield* tides.runNow(tide.id)
      expect(yield* Effect.flip(tides.runNow(tide.id))).toMatchObject({ reason: "rate" })
      expect(yield* Effect.flip(tides.runNow(tide.id))).toMatchObject({ reason: "rate" })
      expect(intakes).toHaveLength(1)
      const limited = (yield* eventsOf("error.raised")).filter((event) =>
        JSON.stringify(event.payload).includes("RateLimited"),
      )
      expect(limited).toHaveLength(1)
    }).pipe(Effect.provide(env))
  })

  it.effect(
    "claims only locks older than five minutes, and a crash between claim and fire is retried once",
    () => {
      const intakes: Array<Intake> = []
      const clock = makeClock()
      const env = tidesEnv(withTempDb(), intakes, { botBudgetWindowMs: DAY_MS, clock: clock.now })
      return Effect.gen(function* () {
        const bot = yield* registerBot
        const tides = yield* Tides
        yield* tides.upsert(cronTide(bot.id))
        clock.advance(2 * MINUTE_MS)
        // The first pass claims the window and "crashes" before firing: the lock is left behind.
        expect(yield* tides.claimDue()).toHaveLength(1)
        expect(yield* tides.claimDue()).toHaveLength(0)
        clock.advance(4 * MINUTE_MS)
        expect(yield* tides.claimDue()).toHaveLength(0)
        clock.advance(2 * MINUTE_MS)
        yield* tides.tick()
        expect(intakes).toHaveLength(1)
        yield* tides.tick()
        expect(intakes).toHaveLength(1)
      }).pipe(Effect.provide(env))
    },
  )

  it.effect("a window three days late fires once and the next run is in the future", () => {
    const intakes: Array<Intake> = []
    const clock = makeClock()
    const env = tidesEnv(withTempDb(), intakes, { botBudgetWindowMs: DAY_MS, clock: clock.now })
    return Effect.gen(function* () {
      const bot = yield* registerBot
      const tides = yield* Tides
      const tide = yield* tides.upsert(cronTide(bot.id))
      const sql = yield* SqlClient
      const late = new Date(clock.now().getTime() - 3 * DAY_MS).toISOString()
      yield* sql`UPDATE tides SET next_run_at = ${late} WHERE id = ${tide.id}`
      yield* tides.tick()
      expect(intakes).toHaveLength(1)
      const [row] = yield* sql<{
        readonly next_run_at: string
      }>`SELECT next_run_at FROM tides WHERE id = ${tide.id}`
      expect(Date.parse(row?.next_run_at ?? "")).toBeGreaterThan(clock.now().getTime())
      yield* tides.tick()
      expect(intakes).toHaveLength(1)
    }).pipe(Effect.provide(env))
  })
})
