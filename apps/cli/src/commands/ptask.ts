import { ProjectTaskState, type SchemaViolation } from "@shoalwork/contracts"
import { Console, Effect, Schema } from "effect"
import { parseArgs, resolveSettings, type Settings, UsageError } from "../args.js"
import { ApiClient, type HttpError } from "../client.js"

export type PtaskCommandError = UsageError | HttpError | SchemaViolation

const SETTINGS_FLAGS = ["url", "token"]

// Mirrors the task view of GET /projects/:slug/tasks (packages/factory/src/kanban-rows.ts).
const ProjectTaskView = Schema.Struct({
  id: Schema.String,
  project: Schema.String,
  title: Schema.String,
  issueNumber: Schema.NullOr(Schema.Int),
  prNumber: Schema.NullOr(Schema.Int),
  state: ProjectTaskState,
  branch: Schema.NullOr(Schema.String),
  retries: Schema.Int,
  manualInterventions: Schema.Int,
  version: Schema.Int,
  updatedAt: Schema.NullOr(Schema.String),
})
const TaskMoved = Schema.Struct({ task: ProjectTaskView })

export type ProjectTaskViewType = typeof ProjectTaskView.Type

// The state is checked before any request: a value the board does not know is a usage error, not a round-trip.
const taskStateOf = (raw: string): Effect.Effect<ProjectTaskState, UsageError> =>
  Schema.decodeUnknownEffect(ProjectTaskState)(raw).pipe(
    Effect.mapError(() => new UsageError({ message: `unknown board state: ${raw}` })),
  )

export const ptaskMove = (
  settings: Settings,
  slug: string,
  taskId: string,
  to: string,
  reason: string | undefined,
): Effect.Effect<ProjectTaskViewType, PtaskCommandError> =>
  Effect.gen(function* () {
    const state = yield* taskStateOf(to)
    const body = { to: state, ...(reason === undefined ? {} : { reason }) }
    const moved = yield* new ApiClient(settings.url, settings.token).post(
      `/projects/${encodeURIComponent(slug)}/tasks/${encodeURIComponent(taskId)}/move`,
      body,
      TaskMoved,
    )
    return moved.task
  })

export const ptaskRetry = (
  settings: Settings,
  slug: string,
  taskId: string,
): Effect.Effect<ProjectTaskViewType, PtaskCommandError> =>
  Effect.gen(function* () {
    const moved = yield* new ApiClient(settings.url, settings.token).post(
      `/projects/${encodeURIComponent(slug)}/tasks/${encodeURIComponent(taskId)}/retry`,
      {},
      TaskMoved,
    )
    return moved.task
  })

// One project slug and one task id as the two positional arguments of move and retry.
const taskRef = (
  positionals: ReadonlyArray<string>,
  sub: string,
  needsTo: boolean,
): Effect.Effect<{ slug: string; taskId: string }, UsageError> => {
  const [slug, taskId, ...extra] = positionals
  return slug === undefined || taskId === undefined || extra.length > 0
    ? Effect.fail(
        new UsageError({ message: `usage: ptask ${sub} <slug> <task id>${needsTo ? " --to <state>" : ""}` }),
      )
    : Effect.succeed({ slug, taskId })
}

const PTASK_SUBCOMMANDS = "move|retry"

export const ptaskCommand = (argv: ReadonlyArray<string>): Effect.Effect<void, PtaskCommandError> => {
  const [sub, ...rest] = argv
  switch (sub) {
    case "move":
      return Effect.gen(function* () {
        const { flags, positionals } = yield* parseArgs(rest, ["to", "reason", ...SETTINGS_FLAGS])
        const ref = yield* taskRef(positionals, "move", true)
        if (flags.to === undefined) {
          return yield* Effect.fail(new UsageError({ message: "ptask move needs --to <state>" }))
        }
        const settings = yield* resolveSettings(flags, process.env)
        yield* Console.log(
          JSON.stringify(yield* ptaskMove(settings, ref.slug, ref.taskId, flags.to, flags.reason)),
        )
      })
    case "retry":
      return Effect.gen(function* () {
        const { flags, positionals } = yield* parseArgs(rest, SETTINGS_FLAGS)
        const ref = yield* taskRef(positionals, "retry", false)
        const settings = yield* resolveSettings(flags, process.env)
        yield* Console.log(JSON.stringify(yield* ptaskRetry(settings, ref.slug, ref.taskId)))
      })
    default:
      return Effect.fail(
        new UsageError({
          message:
            sub === undefined
              ? `missing ptask subcommand (${PTASK_SUBCOMMANDS})`
              : `unknown ptask subcommand: ${sub}`,
        }),
      )
  }
}
