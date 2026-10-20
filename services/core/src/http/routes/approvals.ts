import { Approval, ApprovalId, ApprovalStatus, NotFound } from "@shoalwork/contracts"
import { ApprovalFlow } from "@shoalwork/lead"
import { Approvals } from "@shoalwork/policy"
import { Effect, Schema } from "effect"
import type { Hono } from "hono"
import { failureResponse, type RouteResponse, type RunEffect, sendResponse } from "./respond.js"

// Body of POST /approvals/:id. `via` only says which surface asked (the actor of the decision); the token is the operator's.
export const DecisionBody = Schema.Struct({
  decision: Schema.Literals(["approved", "denied"]),
  via: Schema.optional(Schema.Literals(["web", "cli"])),
})

const ApprovalList = Schema.Array(Approval)

// A malformed id cannot name a stored approval, so it answers 404 like an unknown one.
const idOf = (raw: string) =>
  Schema.decodeUnknownEffect(ApprovalId)(raw).pipe(
    Effect.mapError(() => new NotFound({ entity: "Approval", id: raw })),
  )

const listApprovals = (rawStatus: string | undefined) =>
  Effect.gen(function* () {
    const status =
      rawStatus === undefined ? undefined : yield* Schema.decodeUnknownEffect(ApprovalStatus)(rawStatus)
    const approvals = yield* Approvals
    const found = yield* approvals.list(status === undefined ? {} : { status })
    const encoded = yield* Schema.encodeEffect(ApprovalList)(found)
    return { status: 200, body: { approvals: encoded } } satisfies RouteResponse
  }).pipe(Effect.catch(failureResponse))

const decide = (rawId: string, raw: unknown) =>
  Effect.gen(function* () {
    const id = yield* idOf(rawId)
    const body = yield* Schema.decodeUnknownEffect(DecisionBody)(raw)
    const flow = yield* ApprovalFlow
    const result = yield* flow.decide(id, body.decision, `user:${body.via ?? "api"}`)
    const approval = yield* Schema.encodeEffect(Approval)(result.approval)
    const outcome = result._tag === "Resolved" ? "resolved" : "already"
    return { status: 200, body: { result: outcome, approval } } satisfies RouteResponse
  }).pipe(Effect.catch(failureResponse))

export const registerApprovalRoutes = (app: Hono, runEffect: RunEffect): void => {
  app.get("/approvals", async (c) => sendResponse(c, await runEffect(listApprovals(c.req.query("status")))))

  app.post("/approvals/:id", async (c) => {
    const raw: unknown = await c.req.json().catch(() => null)
    return sendResponse(c, await runEffect(decide(c.req.param("id"), raw)))
  })
}
