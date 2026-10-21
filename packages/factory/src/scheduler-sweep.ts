import type { BeaconShape } from "@shoalwork/beacon"
import { Clock, Effect } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import type { Cycle } from "./cycle.js"
import { cycleOf, cyclesOf } from "./cycle-rows.js"
import { CI_POLL_MS, CI_SILENCE_MS, ORPHAN_MS } from "./cycle-text.js"
import { projectBySlug, tasksOf } from "./kanban.js"
import { projectView, stateOf } from "./kanban-rows.js"
import { isolate, recovered } from "./scheduler-support.js"

// The observer's net (T-030, T-061) for one project; the scheduler runs it under the same lock as a pass:
// - a pull request with no CI event for too long has its checks polled;
// - a cycle that never got its Lead task, and a task in progress that has no cycle at all, go back or get adopted;
// - a task in review without a pull request goes back to the queue.
export const makeSweepProject = (sql: SqlClient, beacon: BeaconShape, cycle: Cycle) => (slug: string) =>
  Effect.gen(function* () {
    const found = yield* projectBySlug(sql, slug)
    if (found === undefined) return 0
    const project = projectView(found)
    const now = yield* Clock.currentTimeMillis
    const tasks = yield* tasksOf(sql, slug)
    let count = 0

    for (const row of yield* cyclesOf(sql, slug)) {
      const task = tasks.find((candidate) => candidate.id === row.taskId)
      if (task === undefined) continue
      const ref = `${slug}/${row.taskId}`
      const silent =
        row.phase === "ci" &&
        row.ciSignal === null &&
        now - row.sinceMs >= CI_SILENCE_MS &&
        (row.checkedMs === null || now - row.checkedMs >= CI_POLL_MS)
      if (silent && task.pr_number !== null) {
        yield* sql`UPDATE project_cycles SET checked_ms = ${now} WHERE project = ${slug} AND task_id = ${row.taskId}`
        const verdict = yield* cycle.confirmCi(project, task, { ...row, checkedMs: now }).pipe(isolate(ref))
        if (verdict === "pass" || verdict === "fail") {
          yield* recovered(beacon, ref, `ci polled: ${verdict}`)
          count += 1
        }
      } else if (row.phase === "work" && row.currentTaskId === null && now - row.sinceMs >= ORPHAN_MS) {
        const action = yield* cycle.recoverOrphan(project, task, row).pipe(isolate(ref))
        yield* recovered(beacon, ref, `orphan cycle ${action ?? "failed"}`)
        count += 1
      }
    }

    for (const task of tasks) {
      const state = stateOf(task.state)
      const ref = `${slug}/${task.id}`
      // A task in review owns a pull request; one without it goes back to the queue.
      if (state === "in_review" && task.pr_number === null) {
        if (!(yield* cycle.move(slug, task.id, "ready", "in review without a pull request"))) continue
        yield* sql`UPDATE project_cycles SET phase = 'settled' WHERE project = ${slug} AND task_id = ${task.id}`
        yield* recovered(beacon, ref, "in_review without pr -> ready")
        count += 1
      }
      // A task in progress with no live cycle (the crash came between the move and the cycle row) is queued again.
      if (state === "in_progress") {
        const own = yield* cycleOf(sql, slug, task.id)
        const touched = task.updated_at === null ? Number.NEGATIVE_INFINITY : Date.parse(task.updated_at)
        if ((own === undefined || own.phase === "settled") && now - touched >= ORPHAN_MS) {
          if (!(yield* cycle.move(slug, task.id, "ready", "in progress without a cycle"))) continue
          yield* recovered(beacon, ref, "in_progress without cycle -> ready")
          count += 1
        }
      }
    }
    return count
  })
