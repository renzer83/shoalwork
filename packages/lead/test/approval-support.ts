import { BeaconTest } from "@shoalwork/beacon"
import { BotRegistryLive } from "@shoalwork/bots"
import type { ExecutorEvent, ExecutorTask, TaskId } from "@shoalwork/contracts"
import { GhClientTest } from "@shoalwork/currents"
import { withTempDb } from "@shoalwork/db/testing"
import { type Executor, makeRegistry } from "@shoalwork/executors"
import { Approvals, ApprovalsLive } from "@shoalwork/policy"
import { Tank } from "@shoalwork/tank"
import { Effect, Layer, Stream } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { ApprovalFlowLive, LeadLive, McpTokensLive, PodNotesLive, TaskStoreLive } from "../src/index.js"
import { createBot, fakeExecutor, Lead, makeFakeTank, SESSION, specFor, TEST_TIERS } from "./support.js"

export const ASK: ExecutorEvent = {
  kind: "approval_needed",
  action: { tool: "Bash", input: { command: "rm -rf build" }, resource: "build/" },
  risk: "irreversible",
}

// Run N of the executor streams the Nth list of events; `runs` records every task it was asked to execute.
export const scripted = (
  scripts: ReadonlyArray<ReadonlyArray<ExecutorEvent>>,
  runs: Array<ExecutorTask>,
): Executor => {
  let call = 0
  return fakeExecutor((_task) => {
    const events = scripts[call] ?? scripts[scripts.length - 1] ?? []
    call += 1
    return Stream.fromIterable(events)
  }, runs)
}

export const STARTED: ExecutorEvent = { kind: "started", sessionId: SESSION }

// The Lead with the Approvals store and the approval flow under it (what the core composes).
export const approvalLayer = (executor: Executor, tank = makeFakeTank()) => {
  const base = Layer.provideMerge(BeaconTest, withTempDb())
  const store = Layer.provideMerge(TaskStoreLive, Layer.provideMerge(BotRegistryLive, base))
  const approvals = Layer.provideMerge(ApprovalsLive, store)
  const deps = Layer.provideMerge(
    Layer.mergeAll(
      Layer.succeed(Tank, tank.shape),
      GhClientTest().layer,
      makeRegistry([executor]),
      McpTokensLive,
      PodNotesLive,
    ),
    approvals,
  )
  return Layer.provideMerge(LeadLive(TEST_TIERS), Layer.provideMerge(ApprovalFlowLive, deps))
}

export const TWO_HOURS = 2 * 60 * 60 * 1000

export const edit = (path: string): ExecutorEvent => ({ kind: "file_edit", path })
export const DONE: ExecutorEvent = { kind: "done", result: "finished", artifacts: [] }

export const jobsOf = (taskId: TaskId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const rows =
      yield* sql`SELECT id FROM jobs WHERE queue = 'tasks' AND json_extract(payload, '$.taskId') = ${taskId}`
    return rows.length
  })

export const editedPaths = (events: ReadonlyArray<{ readonly type: string; readonly payload: unknown }>) =>
  events
    .filter((event) => event.type === "executor.event")
    .flatMap((event) => {
      const inner = (event.payload as { readonly event: { readonly kind: string; readonly path?: string } })
        .event
      return inner.kind === "file_edit" && inner.path !== undefined ? [inner.path] : []
    })

// The task asks, and the pending approval it left.
export const askFirst = (runs: Array<ExecutorTask>) =>
  Effect.gen(function* () {
    const lead = yield* Lead
    const bot = yield* createBot
    const spec = yield* lead.intake(specFor(bot, { kind: "chat" }))
    const verdict = yield* lead.runOnce(spec.id)
    const approvals = yield* Approvals
    const pending = (yield* approvals.listPending())[0]
    if (pending === undefined) {
      return yield* Effect.die("no pending approval")
    }
    return { lead, spec, verdict, pending, runs }
  })
