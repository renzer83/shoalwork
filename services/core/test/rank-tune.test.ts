import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { runMigrations } from "@shoalwork/db"
import { DEFAULT_WEIGHTS, Ranker } from "@shoalwork/reef"
import { Cause, Context, Effect, Exit, Fiber, Layer } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { afterAll, beforeAll, describe, expect } from "vitest"
import { AppLayer, disposeRuntime, RANK_TUNE_CRON, runEffect, startRankTuneFiber } from "../src/runtime.js"

// The whole composition with the env of a fresh install, as in telegram.test.ts.
describe("rank-tune in the core", () => {
  const dir = mkdtempSync(join(tmpdir(), "shoalwork-core-rank-"))
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
  afterAll(async () => {
    await disposeRuntime()
    for (const key of Object.keys(overrides)) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it.live("AppLayer provides the Ranker with the weights of config/context.yaml", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(AppLayer)
      yield* runMigrations.pipe(Effect.provide(context))
      expect(yield* Context.get(context, Ranker).weights()).toEqual(DEFAULT_WEIGHTS)
    }).pipe(Effect.scoped),
  )

  it.live(
    "the rank-tune fiber registers its weekly window and stops when interrupted",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => runEffect(runMigrations))
        const fiber = startRankTuneFiber({ pollMs: 20 })
        const windowOf = () =>
          Effect.promise(() =>
            runEffect(
              Effect.gen(function* () {
                const sql = yield* SqlClient
                return yield* sql<{
                  readonly next_run_at: string
                }>`SELECT next_run_at FROM system_tides WHERE name = 'rank-tune'`
              }),
            ),
          )
        let rows = yield* windowOf()
        for (let attempt = 0; rows.length === 0 && attempt < 100; attempt++) {
          yield* Effect.sleep("50 millis")
          rows = yield* windowOf()
        }
        expect(rows).toHaveLength(1)
        expect(new Date(rows[0]?.next_run_at ?? "").getUTCDay()).toBe(0)
        expect(RANK_TUNE_CRON).toBe("0 4 * * 0")

        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      }),
    30_000,
  )
})
