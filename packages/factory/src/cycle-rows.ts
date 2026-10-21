import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"

// The rows of the delivery cycle (T-061): one per board task that the cycle drives. The board state says where the
// task is on the kanban; the phase says what the cycle waits for.
export const CyclePhase = Schema.Literals([
  "work",
  "fix_wait",
  "fix",
  "ci",
  "e2e",
  "review",
  "merge",
  "merge_wait",
  "merged",
  "settled",
])
export type CyclePhase = typeof CyclePhase.Type

const CycleRow = Schema.Struct({
  project: Schema.String,
  task_id: Schema.String,
  phase: Schema.String,
  current_task_id: Schema.NullOr(Schema.String),
  worker_tasks: Schema.String,
  fixes: Schema.Int,
  ci_signal: Schema.NullOr(Schema.String),
  since_ms: Schema.Int,
  checked_ms: Schema.NullOr(Schema.Int),
  approval_id: Schema.NullOr(Schema.String),
  fix_note: Schema.NullOr(Schema.String),
})

export interface CycleState {
  readonly project: string
  readonly taskId: string
  readonly phase: CyclePhase
  readonly currentTaskId: string | null
  readonly workerTasks: ReadonlyArray<string>
  readonly fixes: number
  readonly ciSignal: "success" | "failure" | null
  readonly sinceMs: number
  readonly checkedMs: number | null
  readonly approvalId: string | null
  readonly fixNote: string | null
}

const decodeStrings = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)))

const stateOf = (row: typeof CycleRow.Type): CycleState => ({
  project: row.project,
  taskId: row.task_id,
  phase: Schema.is(CyclePhase)(row.phase) ? row.phase : "settled",
  currentTaskId: row.current_task_id,
  workerTasks: (() => {
    const decoded = decodeStrings(row.worker_tasks)
    return decoded._tag === "Some" ? decoded.value : []
  })(),
  fixes: row.fixes,
  ciSignal: row.ci_signal === "success" || row.ci_signal === "failure" ? row.ci_signal : null,
  sinceMs: row.since_ms,
  checkedMs: row.checked_ms,
  approvalId: row.approval_id,
  fixNote: row.fix_note,
})

const decodeRows = (rows: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(CycleRow))(rows).pipe(Effect.orDie)

export const cycleOf = (
  sql: SqlClient,
  project: string,
  taskId: string,
): Effect.Effect<CycleState | undefined, SqlError> =>
  Effect.gen(function* () {
    const rows = yield* sql`SELECT project, task_id, phase, current_task_id, worker_tasks, fixes, ci_signal,
      since_ms, checked_ms, approval_id, fix_note FROM project_cycles
      WHERE project = ${project} AND task_id = ${taskId}`
    const [row] = yield* decodeRows(rows)
    return row === undefined ? undefined : stateOf(row)
  })

export const cyclesOf = (
  sql: SqlClient,
  project: string,
): Effect.Effect<ReadonlyArray<CycleState>, SqlError> =>
  Effect.gen(function* () {
    const rows = yield* sql`SELECT project, task_id, phase, current_task_id, worker_tasks, fixes, ci_signal,
      since_ms, checked_ms, approval_id, fix_note FROM project_cycles
      WHERE project = ${project} AND phase != 'settled' ORDER BY task_id`
    return (yield* decodeRows(rows)).map(stateOf)
  })

// The project and board task that a Lead task currently belongs to.
export const cycleOfLeadTask = (
  sql: SqlClient,
  leadTaskId: string,
): Effect.Effect<CycleState | undefined, SqlError> =>
  Effect.gen(function* () {
    const rows = yield* sql`SELECT project, task_id, phase, current_task_id, worker_tasks, fixes, ci_signal,
      since_ms, checked_ms, approval_id, fix_note FROM project_cycles
      WHERE current_task_id = ${leadTaskId} AND phase != 'settled' LIMIT 1`
    const [row] = yield* decodeRows(rows)
    return row === undefined ? undefined : stateOf(row)
  })

// Starts (or restarts, after a retry) the cycle of a task.
export const startCycle = (sql: SqlClient, next: CycleState): Effect.Effect<void, SqlError> =>
  sql`INSERT OR REPLACE INTO project_cycles (project, task_id, phase, current_task_id, worker_tasks,
      fixes, ci_signal, since_ms, checked_ms, approval_id, fix_note)
    VALUES (${next.project}, ${next.taskId}, ${next.phase}, ${next.currentTaskId}, ${JSON.stringify(next.workerTasks)},
      ${next.fixes}, ${next.ciSignal}, ${next.sinceMs}, ${next.checkedMs}, ${next.approvalId}, ${next.fixNote})`.pipe(
    Effect.asVoid,
  )

// Compare-and-set on the phase: only the caller that still sees `expected` writes. False when someone moved first, so
// the same event or tick twice does one dispatch.
export const moveCycle = (
  sql: SqlClient,
  expected: ReadonlyArray<CyclePhase>,
  next: CycleState,
): Effect.Effect<boolean, SqlError> =>
  Effect.gen(function* () {
    const updated = yield* sql<{ readonly task_id: string }>`UPDATE project_cycles SET
      phase = ${next.phase}, current_task_id = ${next.currentTaskId}, worker_tasks = ${JSON.stringify(next.workerTasks)},
      fixes = ${next.fixes}, ci_signal = ${next.ciSignal}, since_ms = ${next.sinceMs}, checked_ms = ${next.checkedMs},
      approval_id = ${next.approvalId}, fix_note = ${next.fixNote}
      WHERE project = ${next.project} AND task_id = ${next.taskId} AND ${sql.in("phase", [...expected])}
      RETURNING task_id`
    return updated.length > 0
  })

// CI results are recorded while the worker is still delivering too: a fast CI must not be lost. The newest event
// wins. It is only a hint (the cycle confirms it with the checks of the pull request before it acts), so a late result
// of an older push costs one check and never a fix.
export const signalCi = (
  sql: SqlClient,
  project: string,
  branch: string,
  signal: "success" | "failure",
): Effect.Effect<number, SqlError> =>
  Effect.gen(function* () {
    const updated = yield* sql<{ readonly task_id: string }>`UPDATE project_cycles SET ci_signal = ${signal}
      WHERE project = ${project} AND phase IN ('work', 'fix', 'ci')
        AND task_id IN (SELECT id FROM project_tasks WHERE project = ${project} AND branch = ${branch})
      RETURNING task_id`
    return updated.length
  })

// The hint is wrong or spent (the checks said pending): the next event sets it again.
export const clearCiSignal = (
  sql: SqlClient,
  project: string,
  taskId: string,
  checkedMs: number,
): Effect.Effect<void, SqlError> =>
  sql`UPDATE project_cycles SET ci_signal = NULL, checked_ms = ${checkedMs}
    WHERE project = ${project} AND task_id = ${taskId} AND phase = 'ci'`.pipe(Effect.asVoid)

// Does a task of the project own this branch? And is a task still delivering without one (its worker has not named
// the branch yet)? A result for an unknown branch is held back only while the second is true.
export const branchKnown = (
  sql: SqlClient,
  project: string,
  branch: string,
): Effect.Effect<boolean, SqlError> =>
  Effect.gen(function* () {
    const rows = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM project_tasks
      WHERE project = ${project} AND branch = ${branch}`
    return (rows[0]?.n ?? 0) > 0
  })

export const awaitingBranch = (sql: SqlClient, project: string): Effect.Effect<boolean, SqlError> =>
  Effect.gen(function* () {
    const rows = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM project_cycles c
      JOIN project_tasks t ON t.project = c.project AND t.id = c.task_id
      WHERE c.project = ${project} AND c.phase IN ('work', 'fix') AND t.branch IS NULL`
    return (rows[0]?.n ?? 0) > 0
  })

export const cursorOf = (sql: SqlClient, project: string): Effect.Effect<number, SqlError> =>
  Effect.gen(function* () {
    const rows = yield* sql<{ readonly position: number }>`SELECT position FROM project_cycle_cursors
      WHERE project = ${project}`
    return rows[0]?.position ?? 0
  })

export const saveCursor = (
  sql: SqlClient,
  project: string,
  position: number,
): Effect.Effect<void, SqlError> =>
  sql`INSERT OR REPLACE INTO project_cycle_cursors (project, position) VALUES (${project}, ${position})`.pipe(
    Effect.asVoid,
  )
