import { randomUUID } from "node:crypto"
import { Beacon } from "@shoalwork/beacon"
import { ExecutorId, executorStreamId, NotFound, QuotaStatus } from "@shoalwork/contracts"
import { ExecutorRegistry, QuotaStore } from "@shoalwork/executors"
import { DateTime, Effect, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type { Hono } from "hono"
import { hostDoctor } from "../../executors-compose.js"
import { failureResponse, type RouteResponse, type RunEffect, sendResponse } from "./respond.js"

// Who the event names: the API, as the control routes do.
const BY = "api"

// The reports of packages/executors/src/doctor.ts, checked on the way out. Mirrored by apps/cli/src/commands/executors.ts.
const DoctorReportWire = Schema.Struct({
  executor: ExecutorId,
  bin: Schema.String,
  installed: Schema.NullOr(Schema.String),
  pinned: Schema.String,
  status: Schema.Literals(["ok", "drift", "missing", "auth_missing"]),
  detail: Schema.optionalKey(Schema.String),
})
const DoctorList = Schema.Array(DoctorReportWire)

// `exhaustedUntil`: an ISO instant, or null to clear the mark. The store reads an instant not after now as a clear, so
// clearing sends the epoch. A future instant only extends the window (the store never shortens it).
const SetQuotaBody = Schema.Struct({ exhaustedUntil: Schema.NullOr(Schema.DateTimeUtcFromString) })
const CLEAR_AT = DateTime.makeUnsafe(0)
const QuotaList = Schema.Array(QuotaStatus)

// An executor with no window in quotas.yaml (the chat adapter, the ACP agents) has no quota to set.
const NO_WINDOW: RouteResponse = {
  status: 409,
  body: { error: "conflict", reason: "executor has no quota window" },
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

export const registerExecutorRoutes = (app: Hono, runEffect: RunEffect): void => {
  app.get("/executors/quota", async (c) => sendResponse(c, await runEffect(listQuotas)))
  app.get("/executors/doctor", async (c) => sendResponse(c, await runEffect(doctorReports)))
  app.post("/executors/:id/quota", async (c) => {
    const raw: unknown = await c.req.json().catch(() => null)
    return sendResponse(c, await runEffect(setQuota(c.req.param("id"), raw)))
  })
}
