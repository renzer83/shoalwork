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
// The secret of a generic webhook: shown once, by `tide add --webhook` or `tide webhook`.
const WebhookSecret = Schema.Struct({ tideId: TideId, path: Schema.String, secret: Schema.String })

const tideIdOf = (raw: string): Effect.Effect<TideId, UsageError> =>
  Schema.decodeUnknownEffect(TideId)(raw).pipe(
    Effect.mapError(() => new UsageError({ message: `not a tide id: ${raw}` })),
  )

export const tideList = (settings: Settings, flags: Flags): Effect.Effect<unknown, TideCommandError> => {
  const query = flags.bot === undefined ? "" : `?bot=${encodeURIComponent(flags.bot)}`
  return new ApiClient(settings.url, settings.token).get(`/tides${query}`, TideList)
}

// The Tide is written as JSON (the CLI has no yaml reader): the same fields as a `tides:` entry of a bot file,
// with the cron as `cronExpr`, the event as `eventType` and the task as `taskTemplate`. With `webhook`, a new secret
// is generated for the Tide and comes back in the answer, once.
export const tideAdd = (
  settings: Settings,
  flags: Flags,
  webhook = false,
): Effect.Effect<unknown, TideCommandError> =>
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
    const client = new ApiClient(settings.url, settings.token)
    const created = yield* client.post("/tides", { ...fields, bot }, TideCreated)
    if (!webhook) {
      return created
    }
    const secret = yield* client.post(`/tides/${created.tide.id}/webhook-secret`, {}, WebhookSecret)
    return { ...created, webhook: secret }
  })

// Replaces the webhook secret of a Tide: the previous one stops working, the new one is shown once.
export const tideWebhook = (settings: Settings, rawId: string): Effect.Effect<unknown, TideCommandError> =>
  Effect.gen(function* () {
    const id = yield* tideIdOf(rawId)
    return yield* new ApiClient(settings.url, settings.token).post(
      `/tides/${id}/webhook-secret`,
      {},
      WebhookSecret,
    )
  })

// `--webhook` takes no value, so it is taken out before the value flags are parsed. Pairs are read the way parseArgs
// reads them: a flag takes the next argument whatever it looks like.
export const takeSwitch = (
  argv: ReadonlyArray<string>,
  name: string,
): { readonly on: boolean; readonly rest: ReadonlyArray<string> } => {
  const rest: Array<string> = []
  let on = false
  let i = 0
  while (i < argv.length) {
    const token = argv[i] ?? ""
    if (token === `--${name}`) {
      on = true
      i += 1
    } else if (token.startsWith("--")) {
      const value = argv[i + 1]
      rest.push(token)
      if (value !== undefined) {
        rest.push(value)
      }
      i += value === undefined ? 1 : 2
    } else {
      rest.push(token)
      i += 1
    }
  }
  return { on, rest }
}

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

const TIDE_SUBCOMMANDS = "list|add|enable|disable|run|webhook"
const SETTINGS_FLAGS = ["url", "token"]

// `tide list|add|enable|disable|run|webhook`: the Tide commands of the CLI, each a call to the /tides routes.
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
        const switched = takeSwitch(rest, "webhook")
        const { flags } = yield* parseArgs(switched.rest, ["bot", "file", ...SETTINGS_FLAGS])
        const settings = yield* resolveSettings(flags, process.env)
        yield* Console.log(JSON.stringify(yield* tideAdd(settings, flags, switched.on)))
      })
    case "webhook":
      return Effect.gen(function* () {
        const { flags, positionals } = yield* parseArgs(rest, SETTINGS_FLAGS)
        const [id] = positionals
        if (id === undefined) {
          return yield* Effect.fail(new UsageError({ message: "usage: tide webhook <tide id>" }))
        }
        const settings = yield* resolveSettings(flags, process.env)
        yield* Console.log(JSON.stringify(yield* tideWebhook(settings, id)))
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
