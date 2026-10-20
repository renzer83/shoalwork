import type { NotFound, SchemaViolation } from "@shoalwork/contracts"
import { Effect, type Schema, SchemaIssue } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import type { Context } from "hono"
import type { AppServices } from "../../runtime.js"
import type { ScopeViolation } from "../principal.js"

// Route handlers run their programs through this. Method syntax on purpose: the health tests inject a runtime that
// only provides SqlClient, and bivariant parameters let that pass without giving the health route more services.
export type RunEffect = {
  bivarianceHack<A, E>(eff: Effect.Effect<A, E, AppServices>): Promise<A>
}["bivarianceHack"]

export type RouteStatus = 200 | 201 | 400 | 401 | 403 | 404 | 500

export interface RouteResponse {
  readonly status: RouteStatus
  readonly body: unknown
}

export const UNAUTHORIZED: RouteResponse = { status: 401, body: { error: "unauthorized" } }

export type RouteFailure = NotFound | SchemaViolation | SqlError | Schema.SchemaError | ScopeViolation

// Route programs end in a RouteResponse value, so typed failures never reach Hono as thrown errors.
export const failureResponse = (error: RouteFailure): Effect.Effect<RouteResponse> => {
  switch (error._tag) {
    case "NotFound":
      return Effect.succeed({ status: 404, body: { error: "not found", entity: error.entity, id: error.id } })
    case "ScopeViolation":
      return Effect.succeed({ status: 403, body: { error: "forbidden", where: error.where } })
    case "SchemaViolation":
      return Effect.succeed({ status: 400, body: { error: "invalid request", where: error.where } })
    case "SchemaError":
      return Effect.succeed({
        status: 400,
        body: {
          error: "invalid request",
          issues: SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues,
        },
      })
    case "SqlError":
      return Effect.logError("route: database error", error.reason._tag).pipe(
        Effect.as({ status: 500, body: { error: "internal error" } }),
      )
  }
}

export const sendResponse = (c: Context, response: RouteResponse) => c.json(response.body, response.status)
