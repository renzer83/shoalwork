import { uptime } from "node:os"
import type { TaskId } from "@shoalwork/contracts"
import { nowIso } from "@shoalwork/db"
import { trackedProcesses } from "@shoalwork/tank"
import { Duration, Effect, Schema } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"

// The process groups a task's run started, kept in task_processes so that a restart of the core can kill the ones
// the dead process left behind. The Tank knows each process by pid and the directory it started in; the run's
// directory is what ties them to the task.
const POLL = Duration.millis(500)
// Gap between SIGTERM and SIGKILL for groups left by a previous process.
const ORPHAN_GRACE = Duration.seconds(1)

const Row = Schema.Struct({ pgid: Schema.Int, started_at: Schema.String })

export const clearProcesses = (sql: SqlClient, taskId: TaskId) =>
  sql`DELETE FROM task_processes WHERE task_id = ${taskId}`.pipe(
    Effect.asVoid,
    Effect.catch((error) => Effect.logWarning("task processes not cleared", error._tag)),
  )

// Records every process the Tank starts in `cwd` while this effect runs. Fork it in the run's scope.
export const watchProcesses = (sql: SqlClient, taskId: TaskId, cwd: string): Effect.Effect<never> => {
  const seen = new Set<number>()
  const pass = Effect.suspend(() =>
    Effect.forEach(
      trackedProcesses().filter((proc) => proc.cwd === cwd && !seen.has(proc.pid)),
      (proc) =>
        Effect.sync(() => seen.add(proc.pid)).pipe(
          Effect.andThen(
            sql`INSERT OR IGNORE INTO task_processes (task_id, pgid, started_at)
              VALUES (${taskId}, ${proc.pid}, ${nowIso()})`,
          ),
        ),
      { discard: true },
    ),
  ).pipe(Effect.catch((error) => Effect.logWarning("task process not recorded", error._tag)))
  return Effect.forever(pass.pipe(Effect.andThen(Effect.sleep(POLL))))
}

const signal = (pgid: number, name: "SIGTERM" | "SIGKILL"): void => {
  try {
    process.kill(-pgid, name)
  } catch {
    // The group is gone, or it is not ours to signal.
  }
}

// Kills the groups a previous process recorded for the task. A record older than the last boot of the machine is
// stale: its pid may belong to something else now, so it is dropped without a signal. Returns the groups signalled.
export const killOrphanGroups = (sql: SqlClient, taskId: TaskId) =>
  Effect.gen(function* () {
    const rows = yield* sql`SELECT pgid, started_at FROM task_processes WHERE task_id = ${taskId}`
    const found = yield* Schema.decodeUnknownEffect(Schema.Array(Row))(rows).pipe(Effect.orDie)
    const bootedAt = Date.now() - uptime() * 1000
    const live = found.filter((row) => Date.parse(row.started_at) >= bootedAt)
    for (const row of live) {
      signal(row.pgid, "SIGTERM")
    }
    if (live.length > 0) {
      yield* Effect.sleep(ORPHAN_GRACE)
      for (const row of live) {
        signal(row.pgid, "SIGKILL")
      }
    }
    yield* clearProcesses(sql, taskId)
    return live.length
  })
