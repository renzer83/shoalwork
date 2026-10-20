import { BotRegistry } from "@shoalwork/bots"
import { SchemaViolation } from "@shoalwork/contracts"
import { importMarkdownDir, type Reef } from "@shoalwork/reef"
import { Data, Effect, Schema } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import type { Context, Hono } from "hono"
import { failureResponse, type RouteResponse, sendResponse } from "./respond.js"

export type MemoryServices = Reef | SqlClient | BotRegistry

// Same bivariance trick as RunEffect: a runner that provides the whole AppServices also fits.
export type RunMemory = {
  bivarianceHack<A, E>(eff: Effect.Effect<A, E, MemoryServices>): Promise<A>
}["bivarianceHack"]

// A "bot:<name>" scope that names no bot. The CLI accepts names; the stored owner is always the BotId.
export class UnknownBotError extends Data.TaggedError("UnknownBotError")<{ readonly name: string }> {}

// The core reads the directory itself: the CLI runs on the same machine and sends an absolute path.
const ImportBody = Schema.Struct({
  dir: Schema.String,
  scope: Schema.String,
  kind: Schema.Literals(["semantic", "procedural"]),
  source: Schema.String,
})

interface Owner {
  readonly scope: "global" | "bot"
  readonly ownerId: string
}

// "global" is owned by "global"; "bot:<name>" is owned by the BotId that the registry holds under that name.
const ownerOf = (
  scope: string,
): Effect.Effect<Owner, SchemaViolation | UnknownBotError | SqlError, BotRegistry> => {
  if (scope === "global") {
    return Effect.succeed({ scope: "global", ownerId: "global" })
  }
  const name = /^bot:(.+)$/.exec(scope)?.[1]
  if (name === undefined) {
    return Effect.fail(
      new SchemaViolation({ where: "memory.import.scope", issue: `unsupported scope: ${scope}` }),
    )
  }
  return Effect.gen(function* () {
    const registry = yield* BotRegistry
    const bot = yield* registry
      .getByName(name)
      .pipe(Effect.catchTag("NotFound", () => Effect.fail(new UnknownBotError({ name }))))
    return { scope: "bot", ownerId: bot.id } satisfies Owner
  })
}

const readJson = (c: Context): Effect.Effect<unknown, SchemaViolation> =>
  Effect.tryPromise({
    try: async (): Promise<unknown> => c.req.json(),
    catch: () => new SchemaViolation({ where: "memory.import.body", issue: "body is not JSON" }),
  })

const importRoute = (c: Context): Effect.Effect<RouteResponse, never, MemoryServices> =>
  Effect.gen(function* () {
    const raw = yield* readJson(c)
    const input = yield* Schema.decodeUnknownEffect(ImportBody)(raw)
    const owner = yield* ownerOf(input.scope)
    const report = yield* importMarkdownDir({
      dir: input.dir,
      scope: owner.scope,
      ownerId: owner.ownerId,
      kind: input.kind,
      source: input.source,
    })
    return { status: 200, body: report } satisfies RouteResponse
  }).pipe(
    Effect.catchTags({
      UnknownBotError: (error) =>
        Effect.succeed({
          status: 404,
          body: { error: "unknown bot", name: error.name },
        } satisfies RouteResponse),
      WalkError: (error) =>
        Effect.succeed({
          status: 400,
          body: { error: "cannot read directory", reason: error.reason },
        } satisfies RouteResponse),
      EmbedError: (error) =>
        Effect.logError("memory import: embedder failed", error.reason).pipe(
          Effect.as({ status: 500, body: { error: "embedder unavailable" } } satisfies RouteResponse),
        ),
    }),
    Effect.catch((error) => failureResponse(error)),
  )

export const registerMemoryRoutes = (app: Hono, runMemory: RunMemory): void => {
  app.post("/memory/import", async (c) => {
    const response = await runMemory(importRoute(c))
    return sendResponse(c, response)
  })
}
