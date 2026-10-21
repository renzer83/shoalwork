import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import {
  type BotFileExists,
  type BotFileMissing,
  BotRegistry,
  type BotWriteError,
  replaceBotYaml,
  restoreBotYaml,
  writeBotYaml,
} from "@shoalwork/bots"
import {
  type Bot,
  BotId,
  type NewBot,
  NewBot as NewBotSchema,
  NotFound,
  SchemaViolation,
} from "@shoalwork/contracts"
import { Effect, Schema, Struct } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { Context, Hono } from "hono"
import {
  failureResponse,
  type RouteFailure,
  type RouteResponse,
  type RunEffect,
  sendResponse,
} from "./respond.js"

// Fields a PATCH may set. `id` and `name` never change: the name is the file name and the identity of the Bot.
const EDITABLE: ReadonlyArray<string> = [
  "role",
  "instructions",
  "kind",
  "executors",
  "modelTiers",
  "connectors",
  "budget",
  "policy",
  "tank",
  "memory",
  "telegram",
]

// BotName allows 31 characters at most.
const CLONE_NAME_MAX = 31
const CLONE_ATTEMPTS = 20

type FileError = BotFileExists | BotFileMissing | BotWriteError
type Program = Effect.Effect<RouteResponse, RouteFailure | FileError, BotRegistry | SqlClient>

// The actor of the bot.state_changed event an archive writes (the app asked for it).
const APP_ACTOR = "user:app"

const BodyObject = Schema.Record(Schema.String, Schema.Unknown)

const CONFLICT = (reason: string): RouteResponse => ({ status: 409, body: { error: "conflict", reason } })

// A refused file write is an answer about the file, not a failure of the request.
const fileAnswer = (error: FileError): Effect.Effect<RouteResponse> => {
  switch (error._tag) {
    case "BotFileExists":
      return Effect.succeed(CONFLICT("bot file already exists"))
    case "BotFileMissing":
      return Effect.succeed(CONFLICT("bot has no definition file to edit"))
    case "BotWriteError":
      return Effect.logError("bots: yaml write failed", error.message).pipe(
        Effect.as({ status: 500, body: { error: "internal error" } } satisfies RouteResponse),
      )
  }
}

// Every write program ends here: file refusals and typed failures become responses.
const respond = (program: Program): Effect.Effect<RouteResponse, never, BotRegistry | SqlClient> =>
  program.pipe(
    Effect.catchTags({
      BotFileExists: fileAnswer,
      BotFileMissing: fileAnswer,
      BotWriteError: fileAnswer,
    }),
    Effect.catch(failureResponse),
  )

const readObject = (
  c: Context,
): Effect.Effect<Record<string, unknown>, SchemaViolation | Schema.SchemaError> =>
  Effect.tryPromise({
    try: async (): Promise<unknown> => c.req.json(),
    catch: () => new SchemaViolation({ where: "bot.body", issue: "body is not JSON" }),
  }).pipe(Effect.flatMap((raw) => Schema.decodeUnknownEffect(BodyObject)(raw)))

const withBody = (c: Context, next: (body: Record<string, unknown>) => Program) =>
  respond(readObject(c).pipe(Effect.flatMap(next)))

const decodeNewBot = (raw: unknown) => Schema.decodeUnknownEffect(NewBotSchema)(raw)

const botIdOf = (raw: string) =>
  Schema.decodeUnknownEffect(BotId)(raw).pipe(Effect.mapError(() => new NotFound({ entity: "Bot", id: raw })))

// A name is free when the registry and bots/ both lack it (a Bot can exist in one of them only).
const isTaken = (name: string, botsDir: string) =>
  Effect.gen(function* () {
    const registry = yield* BotRegistry
    const inRegistry = yield* registry.getByName(name).pipe(
      Effect.as(true),
      Effect.catchTag("NotFound", () => Effect.succeed(false)),
    )
    return inRegistry || existsSync(join(botsDir, `${name}.yaml`))
  })

// The yaml first (it is the source of truth on boot), then the registry row and its event. A failed row write
// removes the new file again.
const persistNew = (bot: NewBot, botsDir: string) =>
  Effect.gen(function* () {
    const registry = yield* BotRegistry
    const path = yield* writeBotYaml(botsDir, bot)
    const created = yield* registry
      .upsert(bot, "api")
      .pipe(Effect.tapError(() => Effect.sync(() => rmSync(path, { force: true }))))
    return { status: 201, body: { bot: { ...created, state: "idle" } } } satisfies RouteResponse
  })

const createBot = (raw: Record<string, unknown>, botsDir: string): Program =>
  Effect.gen(function* () {
    const bot = yield* decodeNewBot(raw)
    if (yield* isTaken(bot.name, botsDir)) {
      return CONFLICT("bot name already taken")
    }
    return yield* persistNew(bot, botsDir)
  })

const patchBot = (id: string, patch: Record<string, unknown>, botsDir: string): Program =>
  Effect.gen(function* () {
    const botId = yield* botIdOf(id)
    const registry = yield* BotRegistry
    const current = yield* registry.get(botId)
    for (const key of Object.keys(patch)) {
      if (!EDITABLE.includes(key)) {
        return yield* Effect.fail(new SchemaViolation({ where: `bot.${key}`, issue: "not editable" }))
      }
    }
    const next = yield* decodeNewBot({ ...Struct.omit(current, ["id"]), ...patch })
    const previous = yield* replaceBotYaml(botsDir, next)
    const updated = yield* registry
      .update(botId, next, "api")
      .pipe(Effect.tapError(() => restoreBotYaml(botsDir, next.name, previous).pipe(Effect.ignore)))
    return { status: 200, body: { bot: updated } } satisfies RouteResponse
  })

// `<base>-copy`, then `-copy-2`, `-copy-3`…; the base is cut so the whole name still fits BotName.
export const cloneName = (base: string, attempt: number): string => {
  const suffix = attempt === 1 ? "-copy" : `-copy-${attempt}`
  return `${base.slice(0, CLONE_NAME_MAX - suffix.length)}${suffix}`
}

const freeCloneName = (base: string, botsDir: string) =>
  Effect.gen(function* () {
    for (let attempt = 1; attempt <= CLONE_ATTEMPTS; attempt++) {
      const candidate = cloneName(base, attempt)
      if (!(yield* isTaken(candidate, botsDir))) {
        return candidate
      }
    }
    return undefined
  })

// The clone copies the definition but not `telegram`: its threadId is the topic of the source Bot.
const cloneBot = (id: string, botsDir: string): Program =>
  Effect.gen(function* () {
    const botId = yield* botIdOf(id)
    const registry = yield* BotRegistry
    const source = yield* registry.get(botId)
    const name = yield* freeCloneName(source.name, botsDir)
    if (name === undefined) {
      return CONFLICT("no free name for the clone")
    }
    const bot = yield* decodeNewBot({ ...Struct.omit(source, ["id", "telegram"]), name })
    return yield* persistNew(bot, botsDir)
  })

const archivedAnswer = (bot: Bot): RouteResponse => ({
  status: 200,
  body: { bot: { ...bot, state: "archived" } },
})

// Archiving takes the Bot out of new work and writes no file (the state lives in the registry). Idempotent: an
// archived Bot answers 200 with no new event. A Bot holding a task not yet finished answers 409; the task is left to
// its own end or to a stop. The check and the state write share one transaction.
const archiveBot = (id: string): Program =>
  Effect.gen(function* () {
    const botId = yield* botIdOf(id)
    const registry = yield* BotRegistry
    const sql = yield* SqlClient
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const bot = yield* registry.get(botId)
        const listed = (yield* registry.list()).find((entry) => entry.id === botId)
        if (listed?.state === "archived") {
          return archivedAnswer(bot)
        }
        const [open] = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM tasks
          WHERE bot_id = ${botId} AND state NOT IN ('done', 'failed', 'cancelled')`
        if ((open?.n ?? 0) > 0) {
          return CONFLICT("bot has a task in progress")
        }
        yield* registry.setState(botId, "archived", undefined, APP_ACTOR)
        return archivedAnswer(bot)
      }),
    )
  })

// Writes are mounted only when the composition root gives the bots directory (AppDeps.botsDir).
export const registerBotWriteRoutes = (app: Hono, runEffect: RunEffect, botsDir: string): void => {
  app.post("/bots", async (c) =>
    sendResponse(c, await runEffect(withBody(c, (body) => createBot(body, botsDir)))),
  )
  app.patch("/bots/:id", async (c) => {
    const id = c.req.param("id")
    return sendResponse(c, await runEffect(withBody(c, (body) => patchBot(id, body, botsDir))))
  })
  app.post("/bots/:id/clone", async (c) =>
    sendResponse(c, await runEffect(respond(cloneBot(c.req.param("id"), botsDir)))),
  )
  app.post("/bots/:id/archive", async (c) =>
    sendResponse(c, await runEffect(respond(archiveBot(c.req.param("id"))))),
  )
}
