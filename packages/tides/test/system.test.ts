import { it } from "@effect/vitest"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { makeSystemTide, startSystemTide } from "../src/system.js"

// Sundays at 04:00 UTC. 2026-10-21 is a Wednesday.
const EXPR = "0 4 * * 0"
const at = (iso: string) => () => new Date(iso)

const counter = () => {
  let runs = 0
  const run = Effect.sync(() => {
    runs += 1
  })
  return { run, runs: () => runs }
}

describe("system tide", () => {
  it.effect("registers its first window without running and runs once when the window opens", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const job = counter()
      let now = "2026-10-21T10:00:00Z"
      const { tick } = makeSystemTide(sql, {
        name: "rank-tune",
        expr: EXPR,
        run: job.run,
        clock: () => new Date(now),
      })
      yield* tick
      expect(job.runs()).toBe(0)
      const [row] = yield* sql<{ readonly next_run_at: string }>`SELECT next_run_at FROM system_tides`
      expect(row?.next_run_at).toBe("2026-10-25T04:00:00.000Z")

      now = "2026-10-25T04:00:30Z"
      yield* tick
      expect(job.runs()).toBe(1)
      yield* tick
      expect(job.runs()).toBe(1)
      const [after] = yield* sql<{
        readonly next_run_at: string
        readonly locked_at: string | null
      }>`SELECT next_run_at, locked_at FROM system_tides`
      expect(after).toEqual({ next_run_at: "2026-11-01T04:00:00.000Z", locked_at: null })

      now = "2026-11-01T04:05:00Z"
      yield* tick
      expect(job.runs()).toBe(2)
    }).pipe(Effect.provide(withTempDb())),
  )

  it.effect("keeps its window across a restart: a new scheduler does not repeat a spent window", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const job = counter()
      const options = { name: "rank-tune", expr: EXPR, run: job.run }
      yield* makeSystemTide(sql, { ...options, clock: at("2026-10-21T10:00:00Z") }).tick
      yield* makeSystemTide(sql, { ...options, clock: at("2026-10-25T05:00:00Z") }).tick
      yield* makeSystemTide(sql, { ...options, clock: at("2026-10-25T05:01:00Z") }).tick
      expect(job.runs()).toBe(1)
    }).pipe(Effect.provide(withTempDb())),
  )

  it.effect("a failing run is spent: the tick does not fail and the next window is scheduled", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      let now = "2026-10-21T10:00:00Z"
      const { tick } = makeSystemTide(sql, {
        name: "rank-tune",
        expr: EXPR,
        run: Effect.fail("boom"),
        clock: () => new Date(now),
      })
      yield* tick
      now = "2026-10-25T04:10:00Z"
      yield* tick
      const [row] = yield* sql<{ readonly next_run_at: string }>`SELECT next_run_at FROM system_tides`
      expect(row?.next_run_at).toBe("2026-11-01T04:00:00.000Z")
    }).pipe(Effect.provide(withTempDb())),
  )

  it.effect("a window claimed by a scheduler that died is taken over after the lock window", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const job = counter()
      const options = { name: "rank-tune", expr: EXPR, run: job.run }
      yield* makeSystemTide(sql, { ...options, clock: at("2026-10-21T10:00:00Z") }).tick
      yield* sql`UPDATE system_tides SET locked_at = '2026-10-25T04:00:10.000Z'`
      yield* makeSystemTide(sql, { ...options, clock: at("2026-10-25T04:01:00Z") }).tick
      expect(job.runs()).toBe(0)
      yield* makeSystemTide(sql, { ...options, clock: at("2026-10-25T04:30:00Z") }).tick
      expect(job.runs()).toBe(1)
    }).pipe(Effect.provide(withTempDb())),
  )

  it.effect("a schedule that cannot run registers nothing and runs nothing", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const job = counter()
      yield* makeSystemTide(sql, {
        name: "x",
        expr: "not a cron",
        run: job.run,
        clock: at("2026-10-21T10:00:00Z"),
      }).tick
      expect(job.runs()).toBe(0)
      expect(yield* sql`SELECT * FROM system_tides`).toEqual([])
    }).pipe(Effect.provide(withTempDb())),
  )
})

describe("system tide locks and start", () => {
  it.effect("a run does not release a window that another scheduler took over meanwhile", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      let now = "2026-10-21T10:00:00Z"
      const takeover = sql`UPDATE system_tides SET locked_at = 'taken-over'`
      const { tick } = makeSystemTide(sql, {
        name: "rank-tune",
        expr: EXPR,
        run: takeover,
        clock: () => new Date(now),
      })
      yield* tick
      now = "2026-10-25T04:10:00Z"
      yield* tick
      const [row] = yield* sql<{
        readonly next_run_at: string
        readonly locked_at: string | null
      }>`SELECT next_run_at, locked_at FROM system_tides`
      expect(row).toEqual({ next_run_at: "2026-10-25T04:00:00.000Z", locked_at: "taken-over" })
    }).pipe(Effect.provide(withTempDb())),
  )

  it.live("an expression croner rejects is reported once at start and never ticks", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const job = counter()
      const options = { name: "bad", expr: "not a cron", run: job.run, clock: at("2026-10-21T10:00:00Z") }
      expect(makeSystemTide(sql, options).runnable).toBe(false)
      yield* Effect.scoped(startSystemTide(sql, { ...options, pollMs: 1 }))
      yield* Effect.sleep("20 millis")
      expect(job.runs()).toBe(0)
      expect(yield* sql`SELECT * FROM system_tides`).toEqual([])
    }).pipe(Effect.provide(withTempDb())),
  )

  it.live("start runs the job when its window is open and stops with the scope", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const job = counter()
      yield* Effect.scoped(
        Effect.gen(function* () {
          // Every minute: the first poll registers the window, a later one finds it open.
          yield* startSystemTide(sql, { name: "every", expr: "* * * * * *", run: job.run, pollMs: 100 })
          yield* Effect.sleep("2500 millis")
        }),
      )
      const ran = job.runs()
      expect(ran).toBeGreaterThan(0)
      yield* Effect.sleep("300 millis")
      expect(job.runs()).toBe(ran)
    }).pipe(Effect.provide(withTempDb())),
  )
})
