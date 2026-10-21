import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { runMigrations } from "@shoalwork/db"
import { Cause, Effect, Exit, Fiber } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { afterAll, beforeAll, describe, expect } from "vitest"
import { EXECUTOR_QUALITY_CRON, EXECUTOR_QUALITY_JOB } from "../src/jobs/executor-quality.js"
import { disposeRuntime, runEffect, startExecutorQualityFiber } from "../src/runtime.js"

// The executor-quality job as a system tide of the core, with the env of a fresh install (as rank-tune.test.ts).
describe("executor-quality in the core", () => {
  const dir = mkdtempSync(join(tmpdir(), "shoalwork-core-quality-"))
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

  it.live(
    "the executor-quality fiber registers its hourly window and stops when interrupted",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => runEffect(runMigrations))
        const fiber = startExecutorQualityFiber({ pollMs: 20 })
        const windowOf = () =>
          Effect.promise(() =>
            runEffect(
              Effect.gen(function* () {
                const sql = yield* SqlClient
                return yield* sql<{
                  readonly next_run_at: string
                }>`SELECT next_run_at FROM system_tides WHERE name = ${EXECUTOR_QUALITY_JOB}`
              }),
            ),
          )
        let rows = yield* windowOf()
        for (let attempt = 0; rows.length === 0 && attempt < 100; attempt++) {
          yield* Effect.sleep("50 millis")
          rows = yield* windowOf()
        }
        expect(rows).toHaveLength(1)
        // The cron is "top of every hour, UTC": the next window sits on minute and second zero.
        expect(EXECUTOR_QUALITY_CRON).toBe("0 * * * *")
        const next = new Date(rows[0]?.next_run_at ?? "")
        expect(next.getUTCMinutes()).toBe(0)
        expect(next.getUTCSeconds()).toBe(0)

        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      }),
    30_000,
  )
})
