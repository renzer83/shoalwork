import { timingSafeEqual } from "node:crypto"
import { basename } from "node:path"
import { Effect, Redacted } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { Hono } from "hono"
import { APP_VERSION } from "../config.js"
import { registerBotRoutes } from "./routes/bots.js"
import { registerEventRoutes } from "./routes/events.js"
import type { RunEffect } from "./routes/respond.js"
import { registerTaskRoutes } from "./routes/tasks.js"

export interface DbProbe {
  readonly dbPath: string
  readonly journalMode: string
}

export type ProbeEffect = Effect.Effect<DbProbe, unknown, SqlClient>

export interface AppDeps {
  readonly apiToken: Redacted.Redacted<string>
  readonly runEffect: RunEffect
  readonly probe?: ProbeEffect | undefined
}

export interface HealthBody {
  readonly ok: boolean
  readonly version: string
  readonly db: "ok" | "error"
  readonly dbPath: string | null
  readonly journalMode: string | null
  readonly uptimeSeconds: number
}

const DB_PROBE_TIMEOUT = "2 seconds"

// select 1 proves the connection answers; the PRAGMAs report where the file is and how it journals.
export const probeDatabase: ProbeEffect = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`select 1`
  const modes = yield* sql.unsafe<{ readonly journal_mode: string }>("PRAGMA journal_mode")
  const databases = yield* sql.unsafe<{ readonly name: string; readonly file: string }>(
    "PRAGMA database_list",
  )
  const main = databases.find((row) => row.name === "main")
  return {
    dbPath: basename(main?.file ?? ""),
    journalMode: modes[0]?.journal_mode ?? "unknown",
  }
})

const checkDatabase = (
  probe: ProbeEffect,
): Effect.Effect<Pick<HealthBody, "db" | "dbPath" | "journalMode">, never, SqlClient> =>
  probe.pipe(
    Effect.timeout(DB_PROBE_TIMEOUT),
    Effect.map((info) => ({ db: "ok" as const, dbPath: info.dbPath, journalMode: info.journalMode })),
    Effect.catch(() =>
      Effect.logWarning("health: database probe failed").pipe(
        Effect.as({ db: "error" as const, dbPath: null, journalMode: null }),
      ),
    ),
  )

// Constant-time comparison; a length mismatch is rejected up front.
const bearerMatches = (header: string | undefined, expected: string): boolean => {
  const token = /^Bearer\s+(.+)$/i.exec(header ?? "")?.[1]
  if (token === undefined) {
    return false
  }
  const given = Buffer.from(token)
  const wanted = Buffer.from(expected)
  return given.length === wanted.length && timingSafeEqual(given, wanted)
}

export const makeApp = (deps: AppDeps): Hono => {
  const app = new Hono()
  const expectedToken = Redacted.value(deps.apiToken)
  const probe = deps.probe ?? probeDatabase

  app.use("*", async (c, next) => {
    if (c.req.path === "/health") {
      return next()
    }
    if (!bearerMatches(c.req.header("authorization"), expectedToken)) {
      return c.json({ error: "unauthorized" }, 401)
    }
    return next()
  })

  app.get("/health", async (c) => {
    const db = await deps.runEffect(checkDatabase(probe))
    const body: HealthBody = {
      ok: db.db === "ok",
      version: APP_VERSION,
      ...db,
      uptimeSeconds: Math.floor(process.uptime()),
    }
    return c.json(body, db.db === "ok" ? 200 : 503)
  })

  registerBotRoutes(app, deps.runEffect)
  registerTaskRoutes(app, deps.runEffect)
  registerEventRoutes(app, deps.runEffect)

  return app
}
