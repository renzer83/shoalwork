import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { Beacon, type ExecutorQualityRow, readExecutorQualityRows } from "@shoalwork/beacon"
import { BotRegistry } from "@shoalwork/bots"
import { ExecutorId, executorStreamId, NotFound, QuotaStatus, TaskKind } from "@shoalwork/contracts"
import { type DoctorReport, ExecutorRegistry, QuotaStore } from "@shoalwork/executors"
import { DateTime, Effect, Ref, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { Hono } from "hono"
import { parseDocument, type YAMLMap } from "yaml"
import { resolveRepoPath } from "../../config.js"
import { botLogins, LOGIN_BINS, type LoginBin, LoginView } from "../../executor-logins.js"
import { DoctorGate, doctorBinOf, hostDoctor, hostDoctorBin } from "../../executors-compose.js"
import { failureResponse, type RouteResponse, type RunEffect, sendResponse } from "./respond.js"

// Who the event names: the API, as the control routes do.
const BY = "api"

// The reports of packages/executors/src/doctor.ts, checked on the way out. Mirrored by apps/cli/src/commands/executors.ts.
const DoctorStatusWire = Schema.Literals(["ok", "drift", "missing", "auth_missing"])
const DoctorReportWire = Schema.Struct({
  executor: ExecutorId,
  bin: Schema.String,
  installed: Schema.NullOr(Schema.String),
  pinned: Schema.String,
  status: DoctorStatusWire,
  detail: Schema.optionalKey(Schema.String),
})
const DoctorList = Schema.Array(DoctorReportWire)

// `exhaustedUntil`: an ISO instant, or null to clear the mark. The store reads an instant not after now as a clear, so
// clearing sends the epoch. A future instant only extends the window (the store never shortens it).
const SetQuotaBody = Schema.Struct({ exhaustedUntil: Schema.NullOr(Schema.DateTimeUtcFromString) })
const CLEAR_AT = DateTime.makeUnsafe(0)
const QuotaList = Schema.Array(QuotaStatus)

// The overview (T-117): one entry per executor. Quality is the 30-day window of executor_quality (T-074).
const QUALITY_DAYS = 30
const QualityView = Schema.Struct({
  kind: TaskKind,
  okRate: Schema.Number,
  n: Schema.Int,
  avgUsd: Schema.Number,
})
const ExecutorView = Schema.Struct({
  id: ExecutorId,
  cli: Schema.NullOr(Schema.String),
  installedVersion: Schema.NullOr(Schema.String),
  pinnedVersion: Schema.NullOr(Schema.String),
  status: Schema.NullOr(DoctorStatusWire),
  ok: Schema.NullOr(Schema.Boolean),
  quota: QuotaStatus,
  quality: Schema.Array(QualityView),
  logins: Schema.Array(LoginView),
})
const ExecutorList = Schema.Array(ExecutorView)

// An executor with no window in quotas.yaml (the chat adapter, the ACP agents) has no quota to set.
const NO_WINDOW: RouteResponse = {
  status: 409,
  body: { error: "conflict", reason: "executor has no quota window" },
}

// An executor whose CLI the doctor does not check (openai-compat, forja, the ollama instances).
const NO_CLI: RouteResponse = {
  status: 409,
  body: { error: "conflict", reason: "executor has no CLI to check" },
}

// The quota of every registered executor, the same figure resolveTier reads.
const listQuotas = Effect.gen(function* () {
  const registry = yield* ExecutorRegistry
  const statuses = yield* Effect.forEach(registry.list(), (id) =>
    Effect.flatMap(registry.get(id), (executor) => executor.quota()),
  )
  const body = yield* Schema.encodeUnknownEffect(QuotaList)(statuses)
  return { status: 200, body: { quotas: body } } satisfies RouteResponse
}).pipe(Effect.catch(failureResponse))

// The mark and its event are one write: both land or neither does. An unknown or malformed executor id answers 404.
const setQuota = (rawId: string, raw: unknown) =>
  Effect.gen(function* () {
    const registry = yield* ExecutorRegistry
    const id = yield* Schema.decodeUnknownEffect(ExecutorId)(rawId).pipe(
      Effect.mapError(() => new NotFound({ entity: "Executor", id: rawId })),
    )
    const executor = yield* registry.get(id)
    const body = yield* Schema.decodeUnknownEffect(SetQuotaBody)(raw)
    const quota = yield* QuotaStore
    if (!quota.hasWindow(id)) {
      return NO_WINDOW
    }
    const sql = yield* SqlClient
    const beacon = yield* Beacon
    const exhaustedUntil = body.exhaustedUntil === null ? null : DateTime.formatIso(body.exhaustedUntil)
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* quota.setExhaustedUntil(id, body.exhaustedUntil ?? CLEAR_AT)
        yield* beacon.append({
          streamId: executorStreamId(id),
          type: "executor.quota_adjusted",
          payload: { executor: id, exhaustedUntil, by: BY },
          actor: BY,
          correlationId: randomUUID(),
        })
      }),
    )
    const status = yield* Schema.encodeUnknownEffect(QuotaStatus)(yield* executor.quota())
    return { status: 200, body: status } satisfies RouteResponse
  }).pipe(Effect.catch(failureResponse))

// GET /executors/doctor: the CLI versions and logins of this host (T-081), as the core's environment sees them.
const doctorReports = Effect.gen(function* () {
  const reports = yield* hostDoctor()
  const body = yield* Schema.encodeUnknownEffect(DoctorList)(reports)
  return { status: 200, body: { reports: body } } satisfies RouteResponse
}).pipe(
  Effect.catchTag("ConfigError", (error) =>
    Effect.succeed({
      status: 500,
      body: { error: "config unreadable", key: error.key },
    } satisfies RouteResponse),
  ),
  Effect.catch(failureResponse),
)

// The CLI whose login an executor shows: the subscription instances only. A variant on another endpoint (@zai, @ollama)
// authenticates with its own key, so the Bot's CLI login says nothing about it.
const loginBinOf = (id: string): LoginBin | undefined => {
  if (id.includes("@")) return undefined
  const bin = doctorBinOf(id)
  return LOGIN_BINS.find((candidate) => candidate === bin)
}

const qualityOf = (rows: ReadonlyArray<ExecutorQualityRow>, id: ExecutorId) =>
  rows
    .filter((row) => row.executor === id && row.window_days === QUALITY_DAYS)
    .map((row) => ({ kind: row.kind, okRate: row.ok_rate, n: row.n, avgUsd: row.avg_usd }))

// One read per source: the doctor verdict (memory), the quota of each executor, the quality table, and each Bot's login.
// Archived Bots are not asked. Nothing here reads a secret; a failed read of one CLI is an unknown login.
const listExecutors = Effect.gen(function* () {
  const registry = yield* ExecutorRegistry
  const gate = yield* DoctorGate
  const sql = yield* SqlClient
  const bots = yield* BotRegistry
  const reports: ReadonlyArray<DoctorReport> = yield* Ref.get(gate)
  const quality = yield* readExecutorQualityRows(sql)
  const active = (yield* bots.list()).filter((bot) => bot.state !== "archived")
  const logins = yield* botLogins(active)
  const views = yield* Effect.forEach(registry.list(), (id) =>
    Effect.gen(function* () {
      const executor = yield* registry.get(id)
      const quota = yield* executor.quota()
      const bin = doctorBinOf(id)
      const report = reports.find((candidate) => candidate.bin === bin)
      const loginBin = loginBinOf(id)
      return {
        id,
        cli: bin ?? null,
        installedVersion: report?.installed ?? null,
        pinnedVersion: report?.pinned ?? null,
        status: report?.status ?? null,
        ok: report === undefined ? null : report.status === "ok",
        quota,
        quality: qualityOf(quality, id),
        logins:
          loginBin === undefined
            ? []
            : logins.filter((entry) => entry.bin === loginBin).map((entry) => entry.login),
      }
    }),
  )
  const body = yield* Schema.encodeUnknownEffect(ExecutorList)(views)
  return { status: 200, body } satisfies RouteResponse
}).pipe(Effect.catch(failureResponse))

// POST /executors/:id/doctor: re-probes only the CLI of this executor, with the same env and timeout as the boot doctor,
// and puts the new verdict in the gate (so a fixed login unblocks the instances at once).
const reprobe = (rawId: string) =>
  Effect.gen(function* () {
    const registry = yield* ExecutorRegistry
    const id = yield* Schema.decodeUnknownEffect(ExecutorId)(rawId).pipe(
      Effect.mapError(() => new NotFound({ entity: "Executor", id: rawId })),
    )
    yield* registry.get(id)
    const bin = doctorBinOf(id)
    if (bin === undefined) return NO_CLI
    const report = yield* hostDoctorBin(bin)
    if (report === undefined) return NO_CLI
    const gate = yield* DoctorGate
    yield* Ref.update(gate, (current) => [...current.filter((candidate) => candidate.bin !== bin), report])
    const body = yield* Schema.encodeUnknownEffect(DoctorReportWire)(report)
    return { status: 200, body: { report: body } } satisfies RouteResponse
  }).pipe(
    Effect.catchTag("ConfigError", (error) =>
      Effect.succeed({
        status: 500,
        body: { error: "config unreadable", key: error.key },
      } satisfies RouteResponse),
    ),
    Effect.catch(failureResponse),
  )

// PATCH /executors/:id body: enabled, isDefault and priority are optional, persisted to config/executors.yaml.
const PatchExecutorBody = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  isDefault: Schema.optionalKey(Schema.Boolean),
  priority: Schema.optionalKey(Schema.Number),
})

// PUT /executors/routing body: order of routes or executor ids.
const PutRoutingBody = Schema.Struct({
  order: Schema.Array(Schema.Unknown),
})

const patchExecutorConfig = (configPath: string, rawId: string, raw: unknown) =>
  Effect.gen(function* () {
    const id = yield* Schema.decodeUnknownEffect(ExecutorId)(rawId).pipe(
      Effect.mapError(() => new NotFound({ entity: "Executor", id: rawId })),
    )
    const body = yield* Schema.decodeUnknownEffect(PatchExecutorBody)(raw)
    const text = existsSync(configPath) ? readFileSync(configPath, "utf8") : "executors:\n"
    const doc = parseDocument(text)
    const executorsNode = doc.get("executors")
    if (!executorsNode || typeof executorsNode !== "object" || !("items" in executorsNode)) {
      return yield* Effect.fail(new NotFound({ entity: "Executor", id }))
    }
    const items = executorsNode.items as Array<YAMLMap>
    const target = items.find((item) => item.get("id") === id)
    if (target === undefined) {
      return yield* Effect.fail(new NotFound({ entity: "Executor", id }))
    }
    if (body.enabled !== undefined) {
      target.set("enabled", body.enabled)
    }
    if (body.priority !== undefined) {
      target.set("priority", body.priority)
    }
    if (body.isDefault !== undefined) {
      if (body.isDefault) {
        target.set("isDefault", true)
        for (const item of items) {
          if (item !== target && item.has("isDefault")) {
            item.delete("isDefault")
          }
        }
      } else {
        target.delete("isDefault")
      }
    }
    writeFileSync(configPath, doc.toString(), "utf8")
    const updated = target.toJSON() as Record<string, unknown>
    return { status: 200, body: { ...updated, executor: updated } } satisfies RouteResponse
  }).pipe(Effect.catch(failureResponse))

const putRoutingConfig = (configPath: string, raw: unknown) =>
  Effect.gen(function* () {
    const body = yield* Schema.decodeUnknownEffect(PutRoutingBody)(raw)
    const text = existsSync(configPath) ? readFileSync(configPath, "utf8") : "executors:\n"
    const doc = parseDocument(text)
    doc.set("routing", { order: body.order })
    writeFileSync(configPath, doc.toString(), "utf8")
    return {
      status: 200,
      body: { routing: { order: body.order }, order: body.order },
    } satisfies RouteResponse
  }).pipe(Effect.catch(failureResponse))

export const registerExecutorRoutes = (
  app: Hono,
  runEffect: RunEffect,
  executorsConfigPath?: string,
): void => {
  const configPath =
    executorsConfigPath ?? resolveRepoPath(process.env.EXECUTORS_CONFIG_PATH ?? "config/executors.yaml")

  app.get("/executors", async (c) => sendResponse(c, await runEffect(listExecutors)))
  app.get("/executors/quota", async (c) => sendResponse(c, await runEffect(listQuotas)))
  app.get("/executors/doctor", async (c) => sendResponse(c, await runEffect(doctorReports)))
  app.put("/executors/routing", async (c) => {
    const raw: unknown = await c.req.json().catch(() => null)
    return sendResponse(c, await runEffect(putRoutingConfig(configPath, raw)))
  })
  app.patch("/executors/:id", async (c) => {
    const raw: unknown = await c.req.json().catch(() => null)
    return sendResponse(c, await runEffect(patchExecutorConfig(configPath, c.req.param("id"), raw)))
  })
  app.post("/executors/:id/doctor", async (c) => sendResponse(c, await runEffect(reprobe(c.req.param("id")))))
  app.post("/executors/:id/quota", async (c) => {
    const raw: unknown = await c.req.json().catch(() => null)
    return sendResponse(c, await runEffect(setQuota(c.req.param("id"), raw)))
  })
}
