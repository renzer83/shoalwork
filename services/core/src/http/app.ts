import { timingSafeEqual } from "node:crypto"
import { basename } from "node:path"
import { Effect, Redacted } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { Hono } from "hono"
import { APP_VERSION } from "../config.js"
import {
  API_PRINCIPAL,
  authenticateExecution,
  isExecutionReadPath,
  type RunMcp,
  setPrincipal,
} from "./principal.js"
import { registerApprovalRoutes } from "./routes/approvals.js"
import { registerBeaconRoutes } from "./routes/beacon.js"
import { registerBotRoutes } from "./routes/bots.js"
import { registerBotWriteRoutes } from "./routes/bots-write.js"
import { registerConnectorRoutes } from "./routes/connectors.js"
import { registerControlRoutes } from "./routes/control.js"
import { registerCostRoutes } from "./routes/costs.js"
import { registerContextCostRoutes } from "./routes/costs-context.js"
import { registerEventRoutes } from "./routes/events.js"
import { registerExecutorRoutes } from "./routes/executors.js"
import { registerLiveRoutes } from "./routes/live.js"
import { MCP_OAUTH_CALLBACK_PATH, type RunMcpServers, registerMcpServerRoutes } from "./routes/mcp-servers.js"
import { type RunMemory, registerMemoryRoutes } from "./routes/memory.js"
import { registerMessageRoutes } from "./routes/messages.js"
import { registerPodRoutes } from "./routes/pods.js"
import { isExecutionPolicyPath, type RunPolicy, registerPolicyRoutes } from "./routes/policy.js"
import { registerProjectRoutes } from "./routes/projects.js"
import { registerReefRoutes } from "./routes/reef.js"
import { registerReflexRoutes } from "./routes/reflex.js"
import { registerReplayRoutes } from "./routes/replay.js"
import type { RunEffect } from "./routes/respond.js"
import { registerTaskRoutes } from "./routes/tasks.js"
import { registerTideRunRoutes } from "./routes/tide-runs.js"
import { registerTideRoutes } from "./routes/tides.js"
import { GENERIC_WEBHOOK_PATH, registerGenericWebhookRoutes } from "./routes/webhooks-generic.js"
import { GITHUB_WEBHOOK_PATH, registerGithubWebhookRoutes } from "./routes/webhooks-github.js"
import { html } from "./ui.js"

export interface DbProbe {
  readonly dbPath: string
  readonly journalMode: string
}

export type ProbeEffect = Effect.Effect<DbProbe, unknown, SqlClient>

export interface AppDeps {
  readonly apiToken: Redacted.Redacted<string>
  readonly runEffect: RunEffect
  readonly probe?: ProbeEffect | undefined
  // Mounted only when the composition root provides the Reef and the SqlClient to the HTTP layer.
  readonly runMemory?: RunMemory | undefined
  // Code search, chunk read and execution-token checks. Without it, execution tokens are refused everywhere.
  readonly runMcp?: RunMcp | undefined
  // Policy and Approvals for the permission bridge (T-055): POST /policy/evaluate and GET /approvals/:id/wait.
  // Without it neither route exists and an execution token reaches nothing but the read routes.
  readonly runPolicy?: RunPolicy | undefined
  // The MCP registry routes (T-083): /mcp-servers, /bots/:id/mcp and the OAuth callback. Without it none is mounted.
  readonly runMcpServers?: RunMcpServers | undefined
  // GITHUB_WEBHOOK_SECRET (config.ts). Unset: the GitHub route answers 503 and processes nothing.
  readonly githubWebhookSecret?: Redacted.Redacted<string> | undefined
  // The directory of bots/*.yaml. Mounts the write routes (POST /bots, PATCH /bots/:id, clone) when given.
  readonly botsDir?: string | undefined
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
const tokenMatches = (given: string | undefined, expected: string): boolean => {
  if (given === undefined) {
    return false
  }
  const givenBytes = Buffer.from(given)
  const wanted = Buffer.from(expected)
  return givenBytes.length === wanted.length && timingSafeEqual(givenBytes, wanted)
}

const bearerValue = (header: string | undefined): string | undefined =>
  /^Bearer\s+(.+)$/i.exec(header ?? "")?.[1]

const bearerMatches = (header: string | undefined, expected: string): boolean =>
  tokenMatches(bearerValue(header), expected)

// EventSource cannot set headers, so the live feed also accepts ?token=. Other routes take only the header.
const LIVE_PATH = "/events/live"
// The board page holds no secret (it asks for the token like the chat page), and its feed also takes ?token=.
const BOARD_PAGE_PATH = /^\/projects\/[^/]+\/board$/
const BOARD_LIVE_PATH = /^\/projects\/[^/]+\/live$/

export const makeApp = (deps: AppDeps): Hono => {
  const app = new Hono()
  const expectedToken = Redacted.value(deps.apiToken)
  const probe = deps.probe ?? probeDatabase

  app.use("*", async (c, next) => {
    // The page holds no secret; it asks for the token in the browser and sends it on each request. A generic webhook
    // is authenticated by its Tide's secret (X-Webhook-Secret), not by the API token.
    if (
      c.req.path === "/health" ||
      c.req.path === "/" ||
      BOARD_PAGE_PATH.test(c.req.path) ||
      GENERIC_WEBHOOK_PATH.test(c.req.path) ||
      c.req.path === GITHUB_WEBHOOK_PATH ||
      // The browser lands here from the authorization server with no header; the one-time `state` is the credential.
      (c.req.method === "GET" && c.req.path === MCP_OAUTH_CALLBACK_PATH)
    ) {
      return next()
    }
    const header = c.req.header("authorization")
    const queryToken =
      c.req.path === LIVE_PATH || BOARD_LIVE_PATH.test(c.req.path) ? c.req.query("token") : undefined
    if (bearerMatches(header, expectedToken) || tokenMatches(queryToken, expectedToken)) {
      setPrincipal(c.req.raw, API_PRINCIPAL)
      return next()
    }
    // An execution token opens only the read routes a Bot's MCP server calls, plus the two routes of the permission
    // bridge when they are mounted; each of them checks its scope.
    const presented = bearerValue(header)
    if (
      presented !== undefined &&
      deps.runMcp !== undefined &&
      (isExecutionReadPath(c.req.method, c.req.path) ||
        (deps.runPolicy !== undefined && isExecutionPolicyPath(c.req.method, c.req.path)))
    ) {
      const principal = await deps.runMcp(authenticateExecution(presented))
      if (principal !== undefined) {
        setPrincipal(c.req.raw, principal)
        return next()
      }
    }
    return c.json({ error: "unauthorized" }, 401)
  })

  app.get("/", (c) => c.html(html))

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
  if (deps.botsDir !== undefined) registerBotWriteRoutes(app, deps.runEffect, deps.botsDir)
  registerTaskRoutes(app, deps.runEffect)
  registerProjectRoutes(app, deps.runEffect)
  registerApprovalRoutes(app, deps.runEffect)
  registerTideRoutes(app, deps.runEffect)
  registerGenericWebhookRoutes(app, deps.runEffect)
  registerGithubWebhookRoutes(app, deps.runEffect, deps.githubWebhookSecret)
  registerControlRoutes(app, deps.runEffect)
  registerCostRoutes(app, deps.runEffect)
  registerContextCostRoutes(app, deps.runEffect)
  registerEventRoutes(app, deps.runEffect)
  registerExecutorRoutes(app, deps.runEffect)
  registerLiveRoutes(app, deps.runEffect)
  registerMessageRoutes(app, deps.runEffect)
  registerReplayRoutes(app, deps.runEffect)
  registerPodRoutes(app, deps.runEffect)
  registerTideRunRoutes(app, deps.runEffect)
  registerConnectorRoutes(app, deps.runEffect, deps.botsDir)
  registerBeaconRoutes(app, deps.runEffect)
  registerReflexRoutes(app, deps.runEffect)
  if (deps.runMcpServers !== undefined) registerMcpServerRoutes(app, deps.runMcpServers)
  if (deps.runMemory !== undefined) {
    registerMemoryRoutes(app, deps.runMemory)
  }
  if (deps.runMcp !== undefined) {
    registerReefRoutes(app, deps.runMcp)
  }
  if (deps.runPolicy !== undefined) {
    registerPolicyRoutes(app, deps.runPolicy)
  }

  return app
}
