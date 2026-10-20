import { it } from "@effect/vitest"
import { type ExecutorTask, SchemaViolation } from "@shoalwork/contracts"
import type { Executor, ExecutorContext } from "@shoalwork/executors"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { SqlError, UnknownError } from "effect/sql/SqlError"
import { describe, expect } from "vitest"
import {
  allEvents,
  createBot,
  eventsOf,
  fakeExecutor,
  Lead,
  leadLayer,
  OK_EVENTS,
  specFor,
} from "./support.js"

const REPO = { url: "https://github.com/renzer83/Shoalwork.git", base: "main" } as const
const BRIDGE = {
  serverEntry: "/opt/shoalwork/packages/executors/dist/permission-bridge/index.js",
  mode: "inline",
} as const
const SERVER = { serverEntry: "/opt/shoalwork/packages/reef/dist/mcp.js", api: "http://127.0.0.1:28900" }

const recording = (tasks: Array<ExecutorTask>, contexts: Array<ExecutorContext>): Executor => {
  const base = fakeExecutor(() => eventsOf(OK_EVENTS)())
  return {
    ...base,
    run: (task, ctx) => {
      tasks.push(task)
      contexts.push(ctx)
      return eventsOf(OK_EVENTS)()
    },
  }
}

const TokenRows = Schema.Array(
  Schema.Struct({ cwd: Schema.NullOr(Schema.String), bridge_mode: Schema.NullOr(Schema.String) }),
)
const tokenRows = (taskId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    return yield* Schema.decodeUnknownEffect(TokenRows)(
      yield* sql`SELECT cwd, bridge_mode FROM mcp_tokens WHERE task_id = ${taskId}`,
    )
  })

describe("run-setup with the permission bridge", () => {
  it.effect(
    "the run gets the bridge in its attachment, a token for it, its worktree bound and mode auto",
    () => {
      const tasks: Array<ExecutorTask> = []
      const contexts: Array<ExecutorContext> = []
      return Effect.gen(function* () {
        const lead = yield* Lead
        const bot = yield* createBot
        // No indexed chunks: the bridge does not depend on the index.
        const spec = yield* lead.intake(specFor(bot, { repo: REPO }))
        expect(yield* lead.runOnce(spec.id)).toMatchObject({ kind: "ok" })
        expect(contexts[0]?.mcp?.permissionBridge).toEqual(BRIDGE)
        expect(tasks[0]?.permissionMode).toBe("auto")
        expect(yield* tokenRows(spec.id)).toEqual([{ cwd: contexts[0]?.cwd, bridge_mode: "inline" }])
      }).pipe(
        Effect.provide(
          leadLayer({
            executor: recording(tasks, contexts),
            config: { mcp: { ...SERVER, permissionBridge: BRIDGE } },
          }),
        ),
      )
    },
  )

  it.effect(
    "without the bridge in the config the run keeps its static mode and its token has no bridge",
    () => {
      const tasks: Array<ExecutorTask> = []
      const contexts: Array<ExecutorContext> = []
      return Effect.gen(function* () {
        const lead = yield* Lead
        const bot = yield* createBot
        const spec = yield* lead.intake(specFor(bot))
        yield* lead.runOnce(spec.id)
        expect(tasks[0]?.permissionMode).toBe("edit")
        expect(contexts[0]?.mcp).toBeUndefined()
      }).pipe(Effect.provide(leadLayer({ executor: recording(tasks, contexts), config: { mcp: SERVER } })))
    },
  )

  it.effect("a token that cannot be issued blocks the run, with an event, instead of running weaker", () => {
    const tasks: Array<ExecutorTask> = []
    const contexts: Array<ExecutorContext> = []
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot, { repo: REPO }))
      const verdict = yield* lead.runOnce(spec.id)
      expect(verdict.kind).not.toBe("ok")
      expect(tasks).toEqual([])
      expect((yield* allEvents).filter((event) => event.type === "error.raised")).not.toHaveLength(0)
    }).pipe(
      Effect.provide(
        leadLayer({
          executor: recording(tasks, contexts),
          config: { mcp: { ...SERVER, permissionBridge: BRIDGE } },
          wrapTokens: (real) => ({
            ...real,
            issue: () => Effect.fail(new SchemaViolation({ where: "mcp.issue", issue: "forced" })),
          }),
        }),
      ),
    )
  })

  it.effect("a worktree that cannot be bound blocks the run too", () => {
    const tasks: Array<ExecutorTask> = []
    const contexts: Array<ExecutorContext> = []
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot, { repo: REPO }))
      expect((yield* lead.runOnce(spec.id)).kind).not.toBe("ok")
      expect(tasks).toEqual([])
    }).pipe(
      Effect.provide(
        leadLayer({
          executor: recording(tasks, contexts),
          config: { mcp: { ...SERVER, permissionBridge: BRIDGE } },
          wrapTokens: (real) => ({
            ...real,
            bindWorkspace: () =>
              Effect.fail(
                new SqlError({ reason: new UnknownError({ message: "forced", cause: undefined }) }),
              ),
          }),
        }),
      ),
    )
  })
})
