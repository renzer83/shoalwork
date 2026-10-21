import { Effect } from "effect"
import { type CycleDeps, makeKit } from "./cycle-core.js"
import { makeDispatch } from "./cycle-dispatch.js"
import { makeGates } from "./cycle-gates.js"
import { makeMerge } from "./cycle-merge.js"
import { cycleOf } from "./cycle-rows.js"
import { type ProjectView, stateOf, type TaskRow } from "./kanban-rows.js"

export type { CycleDeps } from "./cycle-core.js"
export type { ChecksVerdict } from "./cycle-gates.js"

// The delivery cycle of one board task (T-061): worker -> PR -> checks -> testpilot -> reviewer (another executor) ->
// merge by policy. Each step is a Lead task or a handoff; the cycle row says which one it waits for. Every move of the
// row is a compare-and-set, so the same tick or event twice does one step.
const BOARD_END: ReadonlySet<string> = new Set(["done", "cancelled", "blocked"])

export const makeCycle = (deps: CycleDeps) => {
  const kit = makeKit(deps)
  const dispatch = makeDispatch(kit)
  const merge = makeMerge(kit)
  const gates = makeGates(kit, dispatch, merge)
  const { sql } = deps

  // One step of one task, from the row of its cycle. A failing Lead call blocks that task and nothing else.
  const advance = (project: ProjectView, task: TaskRow) =>
    Effect.gen(function* () {
      const cycle = yield* cycleOf(sql, project.slug, task.id)
      if (cycle === undefined || cycle.phase === "settled") return
      const state = stateOf(task.state)
      if (BOARD_END.has(state)) {
        yield* sql`UPDATE project_cycles SET phase = 'settled' WHERE project = ${project.slug} AND task_id = ${task.id}`
        return
      }
      if (state === "ready" || state === "backlog") return
      switch (cycle.phase) {
        case "work":
        case "fix":
          return yield* dispatch.afterWorker(project, task, cycle)
        case "fix_wait":
          return yield* dispatch.fixStart(project, task, cycle)
        case "ci":
          if (cycle.ciSignal !== null) yield* gates.confirmCi(project, task, cycle)
          return
        case "e2e":
          return yield* gates.afterE2e(project, task, cycle)
        case "review":
          return yield* gates.afterReview(project, task, cycle)
        case "merge":
          return yield* merge.mergeStart(project, task, cycle)
        case "merge_wait":
          return yield* merge.afterApproval(project, task, cycle)
        case "merged":
          return yield* merge.afterMerged(project, task, cycle)
      }
    }).pipe(kit.orBlock(project.slug, task, "cycle step"))

  return {
    promote: dispatch.promote,
    advance,
    move: kit.move,
    confirmCi: gates.confirmCi,
    recoverOrphan: dispatch.recoverOrphan,
  }
}

export type Cycle = ReturnType<typeof makeCycle>
