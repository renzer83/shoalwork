import { BotRegistry } from "@shoalwork/bots"
import { BotId, NotFound, SchemaViolation } from "@shoalwork/contracts"
import { importMarkdownDir, type MemoryItem, MemoryKind, Reef, type Scored } from "@shoalwork/reef"
import { Data, Effect, Schema } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import type { Context, Hono } from "hono"
import { type Principal, principalOf, ScopeViolation } from "../principal.js"
import { listCurrentItems } from "./memory-list.js"
import { failureResponse, type RouteResponse, sendResponse, UNAUTHORIZED } from "./respond.js"

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

// Written by a person through the API or the CLI. `userId` becomes the `user:<id>` source tag.
const AddBody = Schema.Struct({
  scope: Schema.Literals(["bot", "global"]),
  ownerId: Schema.String,
  kind: Schema.Literals(["semantic", "procedural"]),
  content: Schema.String,
  userId: Schema.String,
})

const EditBody = Schema.Struct({
  content: Schema.String,
  userId: Schema.String,
})

const DEFAULT_SEARCH_K = 20
const MAX_SEARCH_K = 100

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
    catch: () => new SchemaViolation({ where: "memory.body", issue: "body is not JSON" }),
  })

const decodeBody = <A, I>(
  c: Context,
  schema: Schema.Codec<A, I>,
): Effect.Effect<A, SchemaViolation | Schema.SchemaError> =>
  readJson(c).pipe(Effect.flatMap((raw) => Schema.decodeUnknownEffect(schema)(raw)))

const requireText = (where: string, value: string): Effect.Effect<string, SchemaViolation> =>
  value.trim() === ""
    ? Effect.fail(new SchemaViolation({ where, issue: "must not be empty" }))
    : Effect.succeed(value)

const sourceOf = (userId: string): Effect.Effect<string, SchemaViolation> =>
  requireText("memory.userId", userId).pipe(Effect.map((id) => `user:${id}`))

// Public shape of a memory item. Stored columns are snake_case; the API speaks camelCase.
export const toView = (item: MemoryItem) => ({
  id: item.id,
  scope: item.scope,
  ownerId: item.owner_id,
  kind: item.kind,
  content: item.content,
  source: item.source,
  confidence: item.confidence,
  createdAt: item.created_at,
  supersededBy: item.superseded_by,
  forgotten: item.tombstone === 1,
})

// The bot named by a BotId in the query or body. Unknown ids are a 404 from the registry.
const botOf = (
  raw: string,
  where: string,
): Effect.Effect<BotId, SchemaViolation | NotFound | SqlError, BotRegistry> =>
  Effect.gen(function* () {
    const id = yield* Schema.decodeUnknownEffect(BotId)(raw).pipe(
      Effect.mapError(() => new SchemaViolation({ where, issue: "not a BotId" })),
    )
    const registry = yield* BotRegistry
    yield* registry.get(id)
    return id
  })

const parseK = (raw: string | undefined): Effect.Effect<number, SchemaViolation> => {
  if (raw === undefined) {
    return Effect.succeed(DEFAULT_SEARCH_K)
  }
  const k = Number(raw)
  return Number.isInteger(k) && k >= 1 && k <= MAX_SEARCH_K
    ? Effect.succeed(k)
    : Effect.fail(
        new SchemaViolation({ where: "memory.search.k", issue: `k must be an integer 1..${MAX_SEARCH_K}` }),
      )
}

const parseKinds = (
  raw: string | undefined,
): Effect.Effect<ReadonlyArray<MemoryKind> | undefined, SchemaViolation> => {
  if (raw === undefined) {
    return Effect.succeed(undefined)
  }
  return Schema.decodeUnknownEffect(Schema.Array(MemoryKind))(raw.split(",")).pipe(
    Effect.mapError(() => new SchemaViolation({ where: "memory.search.kinds", issue: "unknown kind" })),
  )
}

const importRoute = (c: Context): Effect.Effect<RouteResponse, never, MemoryServices> =>
  Effect.gen(function* () {
    const input = yield* decodeBody(c, ImportBody)
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

// An execution token searches its own Bot only: a `bot` that names another Bot is refused, one that names none is fine.
const botFor = (
  principal: Principal,
  requested: string | undefined,
): Effect.Effect<BotId, SchemaViolation | NotFound | SqlError | ScopeViolation, BotRegistry> => {
  if (principal.kind === "api") {
    return botOf(requested ?? "", "memory.search.bot")
  }
  if (requested === undefined || requested === principal.scope.botId) {
    return Effect.succeed(principal.scope.botId)
  }
  return Effect.fail(new ScopeViolation({ where: "memory.search.bot" }))
}

const listRecent = (bot: BotId, k: number, kinds: ReadonlyArray<MemoryKind> | undefined) =>
  listCurrentItems(bot, k).pipe(
    Effect.map((items): RouteResponse => {
      const kept = items.filter((item) => kinds === undefined || kinds.includes(item.kind))
      return { status: 200, body: kept.map(toView) }
    }),
  )
// GET /memory?bot=<BotId>&q=<text>&k=<1..100, default 20>&kinds=<a,b> → bare array of hits (the MCP decodes this).
const searchRoute = (c: Context): Effect.Effect<RouteResponse, never, MemoryServices> => {
  const principal = principalOf(c.req.raw)
  if (principal === undefined) {
    return Effect.succeed(UNAUTHORIZED)
  }
  return Effect.gen(function* () {
    const bot = yield* botFor(principal, c.req.query("bot"))
    const k = yield* parseK(c.req.query("k"))
    const kinds = yield* parseKinds(c.req.query("kinds"))
    const q = c.req.query("q")
    if (q === undefined) {
      return yield* listRecent(bot, k, kinds)
    }
    yield* requireText("memory.search.q", q)
    const reef = yield* Reef
    const hits: ReadonlyArray<Scored> = yield* reef.search(q, {
      scopes: [{ scope: "bot", ownerId: bot }],
      kinds,
      k,
    })
    return {
      status: 200,
      body: hits.map((hit) => ({ ...toView(hit), score: hit.score })),
    } satisfies RouteResponse
  }).pipe(Effect.catch((error) => failureResponse(error)))
}

// POST /memory {scope: bot|global, ownerId: BotId|"global", kind, content, userId} → 201 {item}.
const addRoute = (c: Context): Effect.Effect<RouteResponse, never, MemoryServices> =>
  Effect.gen(function* () {
    const input = yield* decodeBody(c, AddBody)
    const source = yield* sourceOf(input.userId)
    const content = yield* requireText("memory.content", input.content)
    const ownerId = input.scope === "bot" ? yield* botOf(input.ownerId, "memory.ownerId") : input.ownerId
    const reef = yield* Reef
    const item = yield* reef.remember({ scope: input.scope, ownerId, kind: input.kind, content, source })
    return { status: 201, body: { item: toView(item) } } satisfies RouteResponse
  }).pipe(
    Effect.catchTag("EmbedError", (error) =>
      Effect.logError("memory add: embedder failed", error.reason).pipe(
        Effect.as({ status: 500, body: { error: "embedder unavailable" } } satisfies RouteResponse),
      ),
    ),
    Effect.catch((error) => failureResponse(error)),
  )

// PATCH /memory/:id {content, userId} → supersedes the item (same scope, owner and kind) → 200 {item}.
const editRoute = (c: Context, id: string): Effect.Effect<RouteResponse, never, MemoryServices> =>
  Effect.gen(function* () {
    const input = yield* decodeBody(c, EditBody)
    const source = yield* sourceOf(input.userId)
    const content = yield* requireText("memory.content", input.content)
    const reef = yield* Reef
    const chain = yield* reef.history(id)
    const current = chain.find((item) => item.id === id)
    if (current === undefined) {
      return yield* Effect.fail(new NotFound({ entity: "memory_item", id }))
    }
    const next = yield* reef.supersede(id, { kind: current.kind, content, source })
    return { status: 200, body: { item: toView(next) } } satisfies RouteResponse
  }).pipe(
    Effect.catchTag("EmbedError", (error) =>
      Effect.logError("memory edit: embedder failed", error.reason).pipe(
        Effect.as({ status: 500, body: { error: "embedder unavailable" } } satisfies RouteResponse),
      ),
    ),
    Effect.catch((error) => failureResponse(error)),
  )

// DELETE /memory/:id → tombstone. Forgetting a forgotten item answers 200 again (the Reef treats it as a no-op).
const forgetRoute = (id: string): Effect.Effect<RouteResponse, never, MemoryServices> =>
  Effect.gen(function* () {
    const reef = yield* Reef
    yield* reef.forget(id)
    return { status: 200, body: { forgotten: id } } satisfies RouteResponse
  }).pipe(Effect.catch((error) => failureResponse(error)))

// GET /memory/:id/history → the whole chain, oldest first. An id the Reef never stored is a 404.
const historyRoute = (id: string): Effect.Effect<RouteResponse, never, MemoryServices> =>
  Effect.gen(function* () {
    const reef = yield* Reef
    const chain = yield* reef.history(id)
    if (chain.length === 0) {
      return yield* Effect.fail(new NotFound({ entity: "memory_item", id }))
    }
    return { status: 200, body: { items: chain.map(toView) } } satisfies RouteResponse
  }).pipe(Effect.catch((error) => failureResponse(error)))

export const registerMemoryRoutes = (app: Hono, runMemory: RunMemory): void => {
  app.post("/memory/import", async (c) => {
    const response = await runMemory(importRoute(c))
    return sendResponse(c, response)
  })
  app.get("/memory", async (c) => sendResponse(c, await runMemory(searchRoute(c))))
  app.post("/memory", async (c) => sendResponse(c, await runMemory(addRoute(c))))
  app.patch("/memory/:id", async (c) => sendResponse(c, await runMemory(editRoute(c, c.req.param("id")))))
  app.delete("/memory/:id", async (c) => sendResponse(c, await runMemory(forgetRoute(c.req.param("id")))))
  app.get("/memory/:id/history", async (c) =>
    sendResponse(c, await runMemory(historyRoute(c.req.param("id")))),
  )
}
