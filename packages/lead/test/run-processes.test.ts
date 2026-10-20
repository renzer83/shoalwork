import { spawn } from "node:child_process"
import { it } from "@effect/vitest"
import type { TaskId } from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { clearProcesses, killOrphanGroups } from "../src/run-processes.js"

const TASK = "task_00000000-0000-4000-8000-0000000000aa" as TaskId

// A detached `sleep`, the way the Tank starts a Bot's process: its pid is also its process group id.
const startGroup = (): number => {
  const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" })
  child.unref()
  return child.pid ?? 0
}

const alive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    return false
  }
}

const record = (pgid: number, startedAt: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    yield* sql`INSERT INTO task_processes (task_id, pgid, started_at) VALUES (${TASK}, ${pgid}, ${startedAt})`
  })

const rows = Effect.gen(function* () {
  const sql = yield* SqlClient
  return yield* sql`SELECT pgid FROM task_processes WHERE task_id = ${TASK}`
})

describe("killOrphanGroups", () => {
  it.live("kills the process groups a previous process recorded for the task and forgets them", () => {
    const pgid = startGroup()
    return Effect.gen(function* () {
      const sql = yield* SqlClient
      yield* record(pgid, new Date().toISOString())
      expect(alive(pgid)).toBe(true)

      expect(yield* killOrphanGroups(sql, TASK)).toBe(1)

      // SIGTERM ends `sleep` at once; the group is gone by the time the call returns.
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 100)))
      expect(alive(pgid)).toBe(false)
      expect(yield* rows).toEqual([])
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          try {
            process.kill(-pgid, "SIGKILL")
          } catch {
            // already gone
          }
        }),
      ),
      Effect.provide(withTempDb()),
    )
  })

  it.live(
    "does not signal a record older than the last boot of the machine (its pid may be anyone's now)",
    () => {
      const pgid = startGroup()
      return Effect.gen(function* () {
        const sql = yield* SqlClient
        yield* record(pgid, "2000-01-01T00:00:00.000Z")

        expect(yield* killOrphanGroups(sql, TASK)).toBe(0)

        expect(alive(pgid)).toBe(true)
        expect(yield* rows).toEqual([])
      }).pipe(
        Effect.ensuring(Effect.sync(() => process.kill(-pgid, "SIGKILL"))),
        Effect.provide(withTempDb()),
      )
    },
  )

  it.live("a group that is already gone is not an error", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      // A pid far above any real one.
      yield* record(4_190_000, new Date().toISOString())
      expect(yield* killOrphanGroups(sql, TASK)).toBe(1)
      yield* clearProcesses(sql, TASK)
      expect(yield* rows).toEqual([])
    }).pipe(Effect.provide(withTempDb())),
  )
})
