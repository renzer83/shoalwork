import { Beacon, type BeaconShape } from "@shoalwork/beacon"
import { BotRegistry, type BotRegistryShape } from "@shoalwork/bots"
import {
  NotFound,
  ReplayOverrides,
  SchemaViolation,
  streamIds,
  type TaskId,
  type TaskSpec,
} from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import type { IntakeInput } from "./intake.js"
import { Lead, type LeadShape } from "./lead.js"
import { isTerminal } from "./outcomes.js"
import {
  baseShaOf,
  diffOf,
  executorOf,
  notesOf,
  type ReplayComparison,
  readTaskEvents,
  summarize,
} from "./replay-compare.js"
import { insertReplay, loadSnapshot, replayById, replayOfTask } from "./replay-store.js"
import { emit } from "./tasks.js"

export type { ReplayComparison, ReplayDiff, RunSummary } from "./replay-compare.js"

export interface ReplayDeps {
  readonly sql: SqlClient
  readonly beacon: BeaconShape
  readonly bots: BotRegistryShape
  // The Lead's read of a task (Lead.get): its spec, state and verdict.
  readonly tasks: Pick<LeadShape, "get">
  // The Lead's intake: the replay is an ordinary new task (budget, archived Bot and queue are checked there).
  readonly intake: (input: IntakeInput) => Effect.Effect<TaskSpec, SchemaViolation | NotFound | SqlError>
}

export interface ReplayStarted {
  readonly replayId: string
  readonly sourceTaskId: TaskId
  readonly task: TaskSpec
  readonly overrides: ReplayOverrides
  readonly baseSha: string | null
  readonly contextFrozen: boolean
}

const TITLE_MAX = 200

const refused = (where: string, reason: string) => new SchemaViolation({ where, issue: { reason } })

// The replay of a task (T-122): the same prompt, repo, acceptance and budget run again as a NEW task, with the context
// text the source was given and the commit it started from. The source is never touched. `overrides` can pick an
// executor, a tier and a model, but never widen the Bot: the executor must already be in `executors.allowed` (and not be
// one the source's review excluded), and the run checks it again when it chooses the executor.
export const makeReplay = (deps: ReplayDeps) => {
  const run = (
    taskId: TaskId,
    rawOverrides: unknown = {},
  ): Effect.Effect<ReplayStarted, SchemaViolation | NotFound | SqlError> =>
    Effect.gen(function* () {
      const overrides = yield* Schema.decodeUnknownEffect(ReplayOverrides)(rawOverrides).pipe(
        Effect.mapError((error) => new SchemaViolation({ where: "overrides", issue: error.issue })),
      )
      const source = yield* deps.tasks.get(taskId)
      if (!isTerminal(source.state)) {
        return yield* Effect.fail(refused("task", "not-finished"))
      }
      const { spec } = source
      const bot = yield* deps.bots.get(spec.botId)
      if (overrides.executor !== undefined) {
        const wanted = overrides.executor
        if (!bot.executors.allowed.includes(wanted)) {
          return yield* Effect.fail(refused("overrides.executor", "not-allowed"))
        }
        if (spec.review?.excludeExecutors.includes(wanted) === true) {
          return yield* Effect.fail(refused("overrides.executor", "excluded"))
        }
      }
      // The commit the source started from: its own replay row when it was a replay, else what its run recorded.
      const earlier = yield* replayOfTask(deps.sql, taskId).pipe(
        Effect.catchTag("ReplayUnavailable", () => Effect.fail(refused("task", "replay-unreadable"))),
      )
      const events = yield* readTaskEvents(deps.beacon, taskId)
      const baseSha = earlier?.baseSha ?? baseShaOf(events)
      // A model name belongs to one executor: the override's, else the one the source ran on (known from its log).
      const modelExecutor = overrides.executor ?? executorOf(events)
      if (overrides.model !== undefined && modelExecutor === undefined) {
        return yield* Effect.fail(refused("overrides.model", "executor-unknown"))
      }
      const frozen = (yield* loadSnapshot(deps.sql, taskId)) !== undefined
      const replayId = `rpl_${crypto.randomUUID()}`

      // The new task, its replay row and the audit event become visible together: the worker cannot pick the job up
      // before the row that tells the run what to change exists.
      const task = yield* deps.sql.withTransaction(
        Effect.gen(function* () {
          const created = yield* deps.intake({
            botId: spec.botId,
            title: `Replay: ${spec.title}`.slice(0, TITLE_MAX),
            prompt: spec.prompt,
            kind: spec.kind,
            ...(spec.repo === undefined ? {} : { repo: spec.repo }),
            acceptance: spec.acceptance,
            budget: spec.budget,
            tier: overrides.tier ?? spec.tier,
            origin: "api",
            ...(spec.review === undefined ? {} : { review: spec.review }),
          })
          yield* insertReplay(deps.sql, {
            id: replayId,
            sourceTaskId: taskId,
            newTaskId: created.id,
            overrides,
            baseSha,
            modelExecutor: overrides.model === undefined ? undefined : modelExecutor,
            contextFrozen: frozen,
          })
          yield* emit(deps.beacon, {
            streamId: streamIds.task(created.id),
            type: "replay.created",
            payload: {
              replayId,
              replayOf: taskId,
              taskId: created.id,
              overrides,
              ...(baseSha === undefined ? {} : { baseSha }),
              contextFrozen: frozen,
            },
            actor: "system:lead",
            correlationId: spec.correlationId ?? taskId,
          })
          return created
        }),
      )
      return {
        replayId,
        sourceTaskId: taskId,
        task,
        overrides,
        baseSha: baseSha ?? null,
        contextFrozen: frozen,
      }
    })

  // The two runs side by side, read from their events and verdicts.
  const compare = (replayId: string): Effect.Effect<ReplayComparison, NotFound | SqlError> =>
    Effect.gen(function* () {
      const link = yield* replayById(deps.sql, replayId)
      if (link === undefined) {
        return yield* Effect.fail(new NotFound({ entity: "Replay", id: replayId }))
      }
      const side = (id: TaskId) =>
        Effect.gen(function* () {
          const record = yield* deps.tasks.get(id)
          const events = yield* readTaskEvents(deps.beacon, id)
          return {
            events,
            summary: summarize(events, { taskId: id, state: record.state, verdict: record.verdict }),
          }
        })
      const source = yield* side(link.sourceTaskId)
      const replay = yield* side(link.newTaskId)
      return {
        id: link.id,
        sourceTaskId: link.sourceTaskId,
        newTaskId: link.newTaskId,
        overrides: link.overrides,
        baseSha: link.baseSha ?? null,
        contextFrozen: link.contextFrozen,
        createdAt: link.createdAt,
        source: source.summary,
        replay: replay.summary,
        diff: diffOf(source.summary, replay.summary),
        notes: notesOf(replay.events, replay.summary.verdict ?? undefined),
      }
    })

  return { run, compare }
}

export type ReplayShape = ReturnType<typeof makeReplay>

// The Replay of a runtime that has the Lead, the stores and the Beacon (the core's AppLayer has them all).
export const replayFromServices: Effect.Effect<ReplayShape, never, Lead | SqlClient | Beacon | BotRegistry> =
  Effect.gen(function* () {
    const lead = yield* Lead
    return makeReplay({
      sql: yield* SqlClient,
      tasks: lead,
      beacon: yield* Beacon,
      bots: yield* BotRegistry,
      intake: lead.intake,
    })
  })
