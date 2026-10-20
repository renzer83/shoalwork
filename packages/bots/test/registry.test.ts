import { copyFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { it } from "@effect/vitest"
import { Beacon, BeaconLive } from "@shoalwork/beacon"
import { BotId, NotFound, SchemaViolation, streamIds, TaskId } from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect, Layer, Schema, Stream } from "effect"
import { describe, expect } from "vitest"
import { BotRegistry, BotRegistryLive, loadBotFile } from "../src/index.js"

// Real SQLite per test (fresh file, migrations applied), with the Beacon the registry writes events to.
const TestLayer = Layer.provideMerge(BotRegistryLive, Layer.provideMerge(BeaconLive, withTempDb()))

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url))
const REPO_BOTS = fileURLToPath(new URL("../../../bots/", import.meta.url))
const TASK = "task_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
const UNKNOWN_BOT = Schema.decodeUnknownSync(BotId)("bot_00000000-0000-4000-8000-000000000000")

// A temporary bots/ directory holding one valid definition; removed when the scope closes.
const tempBotDir = Effect.acquireRelease(
  Effect.sync(() => {
    const dir = mkdtempSync(join(tmpdir(), "bots-registry-"))
    copyFileSync(`${FIXTURES}valid.yaml`, join(dir, "scout.yaml"))
    return dir
  }),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
)

const botCreatedEvents = Effect.gen(function* () {
  const beacon = yield* Beacon
  return yield* Stream.runCollect(beacon.readAll(0, ["bot.created"]))
})

describe("BotRegistry", () => {
  it.effect("syncFromDir twice keeps the same id and emits bot.created only once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* tempBotDir
        const registry = yield* BotRegistry
        const [first] = yield* registry.syncFromDir(dir)
        const [second] = yield* registry.syncFromDir(dir)
        expect(first?.id).toMatch(/^bot_/)
        expect(second?.id).toBe(first?.id)
        expect(yield* botCreatedEvents).toHaveLength(1)
      }),
    ).pipe(Effect.provide(TestLayer)),
  )

  it.effect("setState emits bot.state_changed on the bot stream", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* tempBotDir
        const registry = yield* BotRegistry
        const beacon = yield* Beacon
        const [bot] = yield* registry.syncFromDir(dir)
        if (bot === undefined) {
          return yield* Effect.die("syncFromDir returned no bot")
        }
        yield* registry.setState(bot.id, "working", Schema.decodeUnknownSync(TaskId)(TASK))
        const events = yield* Stream.runCollect(beacon.readStream(streamIds.bot(bot.id)))
        const changed = events.filter((event) => event.type === "bot.state_changed")
        expect(changed).toHaveLength(1)
        expect(changed[0]?.streamId).toBe(`bot:${bot.id}`)
        expect(changed[0]?.payload).toMatchObject({
          botId: bot.id,
          from: "idle",
          to: "working",
          taskId: TASK,
        })
        expect(yield* registry.get(bot.id)).toMatchObject({ name: "scout" })
      }),
    ).pipe(Effect.provide(TestLayer)),
  )

  it.effect("get and getByName return NotFound for unknown bots", () =>
    Effect.gen(function* () {
      const registry = yield* BotRegistry
      const byId = yield* Effect.flip(registry.get(UNKNOWN_BOT))
      const byName = yield* Effect.flip(registry.getByName("nobody"))
      expect(byId).toBeInstanceOf(NotFound)
      expect(byName).toBeInstanceOf(NotFound)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("list returns the synced bots with their current state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* tempBotDir
        const registry = yield* BotRegistry
        const [bot] = yield* registry.syncFromDir(dir)
        if (bot === undefined) {
          return yield* Effect.die("syncFromDir returned no bot")
        }
        yield* registry.setState(bot.id, "paused")
        const listed = yield* registry.list()
        expect(listed).toHaveLength(1)
        expect(listed[0]).toMatchObject({ name: "scout", state: "paused" })
      }),
    ).pipe(Effect.provide(TestLayer)),
  )

  it.effect("upsert of an existing name keeps its id and emits no second bot.created", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* tempBotDir
        const registry = yield* BotRegistry
        const [synced] = yield* registry.syncFromDir(dir)
        const definition = yield* loadBotFile(`${FIXTURES}valid.yaml`)
        const updated = yield* registry.upsert({ ...definition, role: "analyst" }, "user:renan")
        expect(updated.id).toBe(synced?.id)
        expect(updated.role).toBe("analyst")
        expect(yield* registry.getByName("scout")).toMatchObject({ id: synced?.id, role: "analyst" })
        expect(yield* botCreatedEvents).toHaveLength(1)
      }),
    ).pipe(Effect.provide(TestLayer)),
  )

  it.effect("syncFromDir of an invalid definition fails with SchemaViolation and stores nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = mkdtempSync(join(tmpdir(), "bots-invalid-"))
        try {
          copyFileSync(`${FIXTURES}invalid-name.yaml`, join(dir, "bad.yaml"))
          const registry = yield* BotRegistry
          const error = yield* Effect.flip(registry.syncFromDir(dir))
          expect(error).toBeInstanceOf(SchemaViolation)
          expect(error.where).toBe(join(dir, "bad.yaml"))
          expect(yield* registry.list()).toHaveLength(0)
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      }),
    ).pipe(Effect.provide(TestLayer)),
  )

  it.effect("syncFromDir of the repository bots/ registers lead", () =>
    Effect.gen(function* () {
      const registry = yield* BotRegistry
      const synced = yield* registry.syncFromDir(REPO_BOTS)
      const lead = yield* registry.getByName("lead")
      expect(synced.map((bot) => bot.name)).toContain("lead")
      expect(lead).toMatchObject({ name: "lead", kind: "fixed", policy: "default" })
    }).pipe(Effect.provide(TestLayer)),
  )
})
