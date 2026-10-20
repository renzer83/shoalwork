import type { SchemaViolation } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import { type Flags, type Settings, UsageError } from "../args.js"
import { ApiClient, type HttpError } from "../client.js"

// Mirrors the memory views of services/core/src/http/routes/memory.ts (toView and the search hits).
export const MemoryView = Schema.Struct({
  id: Schema.String,
  scope: Schema.String,
  ownerId: Schema.String,
  kind: Schema.String,
  content: Schema.String,
  source: Schema.String,
  confidence: Schema.Number,
  createdAt: Schema.String,
  supersededBy: Schema.NullOr(Schema.String),
  forgotten: Schema.Boolean,
})
export type MemoryView = typeof MemoryView.Type

const MemoryHit = Schema.Struct({ ...MemoryView.fields, score: Schema.Number })
const ItemBody = Schema.Struct({ item: MemoryView })
const HistoryBody = Schema.Struct({ items: Schema.Array(MemoryView) })
const ForgottenBody = Schema.Struct({ forgotten: Schema.String })
const BotBody = Schema.Struct({ bot: Schema.Struct({ id: Schema.String }) })

const KINDS: ReadonlyArray<string> = ["semantic", "procedural"]
// Who wrote a memory from the terminal. The core stores it as source "user:<id>".
const DEFAULT_USER = "cli"

type CommandError = UsageError | HttpError | SchemaViolation

const required = (flags: Flags, name: string): Effect.Effect<string, UsageError> => {
  const value = flags[name]
  return value === undefined || value.trim() === ""
    ? Effect.fail(new UsageError({ message: `missing --${name}` }))
    : Effect.succeed(value)
}

const userOf = (flags: Flags): string => flags.user ?? DEFAULT_USER

// Accepts a BotId or a bot name; GET /bots/:idOrName answers the BotId either way.
const botIdOf = (settings: Settings, nameOrId: string): Effect.Effect<string, CommandError> =>
  new ApiClient(settings.url, settings.token)
    .get(`/bots/${encodeURIComponent(nameOrId)}`, BotBody)
    .pipe(Effect.map((body) => body.bot.id))

// search --bot <bot> <query words...> [--k n] [--kinds semantic,procedural]
export const memorySearch = (
  settings: Settings,
  flags: Flags,
  query: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<typeof MemoryHit.Type>, CommandError> =>
  Effect.gen(function* () {
    const bot = yield* required(flags, "bot")
    const text = query.join(" ").trim()
    if (text === "") {
      return yield* Effect.fail(
        new UsageError({ message: "missing query text: memory search --bot <bot> <text>" }),
      )
    }
    const botId = yield* botIdOf(settings, bot)
    const params = new URLSearchParams({ bot: botId, q: text })
    if (flags.k !== undefined) {
      params.set("k", flags.k)
    }
    if (flags.kinds !== undefined) {
      params.set("kinds", flags.kinds)
    }
    return yield* new ApiClient(settings.url, settings.token).get(
      `/memory?${params.toString()}`,
      Schema.Array(MemoryHit),
    )
  })

// add --scope global|bot:<name> --kind semantic|procedural --content <text> [--user <id>]
export const memoryAdd = (
  settings: Settings,
  flags: Flags,
): Effect.Effect<typeof ItemBody.Type, CommandError> =>
  Effect.gen(function* () {
    const scope = yield* required(flags, "scope")
    const kind = yield* required(flags, "kind")
    const content = yield* required(flags, "content")
    if (scope !== "global" && !/^bot:.+$/.test(scope)) {
      return yield* Effect.fail(new UsageError({ message: "--scope must be global or bot:<name>" }))
    }
    if (!KINDS.includes(kind)) {
      return yield* Effect.fail(new UsageError({ message: "--kind must be semantic or procedural" }))
    }
    const client = new ApiClient(settings.url, settings.token)
    const body =
      scope === "global"
        ? { scope: "global", ownerId: "global" }
        : { scope: "bot", ownerId: yield* botIdOf(settings, scope.slice("bot:".length)) }
    return yield* client.post("/memory", { ...body, kind, content, userId: userOf(flags) }, ItemBody)
  })

// edit <memory id> --content <text> [--user <id>]: supersedes the item and answers the new version.
export const memoryEdit = (
  settings: Settings,
  id: string,
  flags: Flags,
): Effect.Effect<typeof ItemBody.Type, CommandError> =>
  Effect.gen(function* () {
    const content = yield* required(flags, "content")
    return yield* new ApiClient(settings.url, settings.token).patch(
      `/memory/${encodeURIComponent(id)}`,
      { content, userId: userOf(flags) },
      ItemBody,
    )
  })

// forget <memory id>: tombstone, the item stays in the history.
export const memoryForget = (
  settings: Settings,
  id: string,
): Effect.Effect<typeof ForgottenBody.Type, CommandError> =>
  new ApiClient(settings.url, settings.token).remove(`/memory/${encodeURIComponent(id)}`, ForgottenBody)

// history <memory id>: the chain of versions, oldest first.
export const memoryHistory = (
  settings: Settings,
  id: string,
): Effect.Effect<typeof HistoryBody.Type, CommandError> =>
  new ApiClient(settings.url, settings.token).get(`/memory/${encodeURIComponent(id)}/history`, HistoryBody)
