import { readFileSync } from "node:fs"
import { type SchemaViolation, TaskSpec, Tide, TideId } from "@shoalwork/contracts"
import { Console, Effect, Schema } from "effect"
import { type Flags, parseArgs, resolveSettings, type Settings, UsageError } from "../args.js"
import { ApiClient, type HttpError } from "../client.js"

export type TideCommandError = UsageError | HttpError | SchemaViolation

// Mirrors the answers of the /tides routes (services/core/src/http/routes/tides.ts).
const TideList = Schema.Struct({ tides: Schema.Array(Tide) })
const TideCreated = Schema.Struct({ tide: Tide })
const TideRun = Schema.Struct({ task: TaskSpec })
const Done = Schema.Struct({ ok: Schema.Boolean })

const tideIdOf = (raw: string): Effect.Effect<TideId, UsageError> =>
  Schema.decodeUnknownEffect(TideId)(raw).pipe(
    Effect.mapError(() => new UsageError({ message: `not a tide id: ${raw}` })),
  )

export const tideList = (settings: Settings, flags: Flags): Effect.Effect<unknown, TideCommandError> => {
  const query = flags.bot === undefined ? "" : `?bot=${encodeURIComponent(flags.bot)}`
  return new ApiClient(settings.url, settings.token).get(`/tides${query}`, TideList)
}

// The Tide is written as JSON (the CLI has no yaml reader): the same fields as a `tides:` entry of a bot file,
// with the cron as `cronExpr`, the event as `eventType` and the task as `taskTemplate`.
export const tideAdd = (settings: Settings, flags: Flags): Effect.Effect<unknown, TideCommandError> =>
  Effect.gen(function* () {
    const bot = flags.bot
    const file = flags.file
    if (bot === undefined || file === undefined) {
      return yield* Effect.fail(new UsageError({ message: "usage: tide add --bot <bot> --file <tide.json>" }))
    }
    const text = yield* Effect.try({
      try: () => readFileSync(file, "utf8"),
      catch: () => new UsageError({ message: `cannot read ${file}` }),
    })
    const raw = yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: () => new UsageError({ message: `${file} is not JSON` }),
    })
    const fields = yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Unknown))(raw).pipe(
      Effect.mapError(() => new UsageError({ message: `${file} must hold one JSON object` })),
    )
    return yield* new ApiClient(settings.url, settings.token).post("/tides", { ...fields, bot }, TideCreated)
  })

export const tideSetEnabled = (
  settings: Settings,
  rawId: string,
  on: boolean,
): Effect.Effect<unknown, TideCommandError> =>
  Effect.gen(function* () {
    const id = yield* tideIdOf(rawId)
    return yield* new ApiClient(settings.url, settings.token).post(
      `/tides/${id}/enable`,
      { enabled: on },
      Done,
    )
  })

export const tideRun = (settings: Settings, rawId: string): Effect.Effect<unknown, TideCommandError> =>
  Effect.gen(function* () {
    const id = yield* tideIdOf(rawId)
    return yield* new ApiClient(settings.url, settings.token).post(`/tides/${id}/run`, {}, TideRun)
  })

const TIDE_SUBCOMMANDS = "list|add|enable|disable|run"
const SETTINGS_FLAGS = ["url", "token"]

// `tide list|add|enable|disable|run`: the Tide commands of the CLI, each a call to the /tides routes.
export const tideCommand = (argv: ReadonlyArray<string>): Effect.Effect<void, TideCommandError> => {
  const [sub, ...rest] = argv
  switch (sub) {
    case "list":
      return Effect.gen(function* () {
        const { flags } = yield* parseArgs(rest, ["bot", ...SETTINGS_FLAGS])
        const settings = yield* resolveSettings(flags, process.env)
        yield* Console.log(JSON.stringify(yield* tideList(settings, flags), null, 2))
      })
    case "add":
      return Effect.gen(function* () {
        const { flags } = yield* parseArgs(rest, ["bot", "file", ...SETTINGS_FLAGS])
        const settings = yield* resolveSettings(flags, process.env)
        yield* Console.log(JSON.stringify(yield* tideAdd(settings, flags)))
      })
    case "enable":
    case "disable":
      return Effect.gen(function* () {
        const { flags, positionals } = yield* parseArgs(rest, SETTINGS_FLAGS)
        const [id] = positionals
        if (id === undefined) {
          return yield* Effect.fail(new UsageError({ message: `usage: tide ${sub} <tide id>` }))
        }
        const settings = yield* resolveSettings(flags, process.env)
        yield* Console.log(JSON.stringify(yield* tideSetEnabled(settings, id, sub === "enable")))
      })
    case "run":
      return Effect.gen(function* () {
        const { flags, positionals } = yield* parseArgs(rest, SETTINGS_FLAGS)
        const [id] = positionals
        if (id === undefined) {
          return yield* Effect.fail(new UsageError({ message: "usage: tide run <tide id>" }))
        }
        const settings = yield* resolveSettings(flags, process.env)
        yield* Console.log(JSON.stringify(yield* tideRun(settings, id)))
      })
    default:
      return Effect.fail(
        new UsageError({
          message:
            sub === undefined
              ? `missing tide subcommand (${TIDE_SUBCOMMANDS})`
              : `unknown tide subcommand: ${sub}`,
        }),
      )
  }
}
