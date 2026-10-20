import {
  BotId,
  BotState,
  type SchemaViolation,
  TaskId,
  TaskSpec,
  TaskState,
  Verdict,
} from "@shoalwork/contracts"
import { Effect, Schema, Struct } from "effect"
import { type Flags, type Settings, UsageError } from "../args.js"
import { ApiClient, type HttpError } from "../client.js"

// Budget every CLI-sent task gets; there are no flags for it yet.
export const DEFAULT_BUDGET = { tokens: 200000, seconds: 1800, usd: 2 } as const
const DEFAULT_KIND = "chat"
const DEFAULT_TIER = "light"
const DEFAULT_BASE = "main"
const TITLE_MAX = 80

// Body of POST /tasks: the spec without its id, which the core assigns.
const NewTaskBody = TaskSpec.mapFields(Struct.omit(["id"]))

const TaskCreated = Schema.Struct({ task: TaskSpec })
export const TaskView = Schema.Struct({
  spec: TaskSpec,
  state: TaskState,
  verdict: Schema.optionalKey(Verdict),
})
export type TaskView = typeof TaskView.Type

// Mirrors GET /bots (services/core/src/http/routes/bots.ts).
export const BotList = Schema.Struct({
  bots: Schema.Array(Schema.Struct({ id: BotId, name: Schema.String, role: Schema.String, state: BotState })),
})

export type TaskCommandError = UsageError | HttpError | SchemaViolation

// Checks what can be checked without the core, so a bad flag never costs a request.
const requireFlags = (
  flags: Flags,
): Effect.Effect<{ readonly bot: string; readonly prompt: string }, UsageError> =>
  Effect.gen(function* () {
    if (flags.bot === undefined) {
      return yield* Effect.fail(new UsageError({ message: "missing --bot <bot id or name>" }))
    }
    if (flags.prompt === undefined) {
      return yield* Effect.fail(new UsageError({ message: "missing --prompt <text>" }))
    }
    if (flags.base !== undefined && flags.repo === undefined) {
      return yield* Effect.fail(new UsageError({ message: "--base needs --repo" }))
    }
    return { bot: flags.bot, prompt: flags.prompt }
  })

// `--bot` takes a bot id as it is (bot_<uuid>); any other value is a name, looked up in GET /bots.
export const resolveBotId = (settings: Settings, bot: string): Effect.Effect<BotId, TaskCommandError> =>
  Effect.gen(function* () {
    if (bot.startsWith("bot_")) {
      return yield* Schema.decodeUnknownEffect(BotId)(bot).pipe(
        Effect.mapError(() => new UsageError({ message: `not a bot id: ${bot}` })),
      )
    }
    const list = yield* new ApiClient(settings.url, settings.token).get("/bots", BotList)
    const found = list.bots.find((candidate) => candidate.name === bot)
    if (found === undefined) {
      return yield* Effect.fail(new UsageError({ message: `unknown bot name: ${bot}` }))
    }
    return found.id
  })

// The schema is the single check on values such as kind and tier.
const buildNewTask = (
  botId: BotId,
  prompt: string,
  flags: Flags,
): Effect.Effect<typeof NewTaskBody.Type, UsageError> => {
  const repo = flags.repo === undefined ? {} : { repo: { url: flags.repo, base: flags.base ?? DEFAULT_BASE } }
  const body = {
    botId,
    title: prompt.slice(0, TITLE_MAX),
    prompt,
    kind: flags.kind ?? DEFAULT_KIND,
    acceptance: [],
    budget: DEFAULT_BUDGET,
    tier: flags.tier ?? DEFAULT_TIER,
    origin: "cli",
    ...repo,
  }
  return Schema.decodeUnknownEffect(NewTaskBody)(body).pipe(
    Effect.mapError((error) => new UsageError({ message: `invalid task: ${error.message}` })),
  )
}

// Resolves to the new task id; the caller prints it.
export const taskSend = (
  settings: Settings,
  flags: Flags,
): Effect.Effect<{ readonly taskId: string }, TaskCommandError> =>
  Effect.gen(function* () {
    const { bot, prompt } = yield* requireFlags(flags)
    const botId = yield* resolveBotId(settings, bot)
    const body = yield* buildNewTask(botId, prompt, flags)
    const created = yield* new ApiClient(settings.url, settings.token).post("/tasks", body, TaskCreated)
    return { taskId: created.task.id }
  })

export const taskShow = (settings: Settings, rawId: string): Effect.Effect<TaskView, TaskCommandError> =>
  Effect.gen(function* () {
    const id = yield* Schema.decodeUnknownEffect(TaskId)(rawId).pipe(
      Effect.mapError(() => new UsageError({ message: `not a task id: ${rawId}` })),
    )
    return yield* new ApiClient(settings.url, settings.token).get(`/tasks/${id}`, TaskView)
  })
