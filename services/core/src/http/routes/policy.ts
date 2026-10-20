import { ApprovalId, BotId, NotFound, SchemaViolation, TaskId, type ToolCall } from "@shoalwork/contracts"
import { Approvals, Policy } from "@shoalwork/policy"
import { Clock, Effect, Option, Schema } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import type { Hono } from "hono"
import { type Principal, principalOf, ScopeViolation } from "../principal.js"
import { failureResponse, type RouteResponse, sendResponse, UNAUTHORIZED } from "./respond.js"

// The permission bridge (T-055) asks the Policy of the product on behalf of the CLI that runs a Bot.
export type PolicyServices = Policy | Approvals

// Same bivariance trick as RunEffect/RunMcp: the runner for the whole AppServices also fits.
export type RunPolicy = {
  bivarianceHack<A, E>(eff: Effect.Effect<A, E, PolicyServices>): Promise<A>
}["bivarianceHack"]

// The only routes an execution token may call besides the read routes (T-055). The token is the run's own.
const WAIT_PATH = /^\/approvals\/[^/]+\/wait$/

export const isExecutionPolicyPath = (method: string, path: string): boolean =>
  (method === "POST" && path === "/policy/evaluate") || (method === "GET" && WAIT_PATH.test(path))

export const EvaluateBody = Schema.Struct({
  botId: Schema.optional(BotId),
  taskId: Schema.optional(TaskId),
  tool: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  input: Schema.Unknown,
  // API token only, and only a workspace root the Policy was configured with (anything else is a 400). An execution
  // token's cwd is ignored: a root taken from the request would let the caller widen its own workspace.
  cwd: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
})

// One long-poll never exceeds this; the bridge repeats the call until the approval is decided.
export const MAX_WAIT_MS = 60_000
export const POLL_MS = 1_000

interface Subject {
  readonly botId: BotId
  readonly taskId: TaskId
}

// An execution token speaks for its own Bot and task only; a body that names others is refused. The API token must say.
const subjectOf = (
  principal: Principal,
  body: typeof EvaluateBody.Type,
): Effect.Effect<Subject, SchemaViolation | ScopeViolation> => {
  if (principal.kind === "execution") {
    const { botId, taskId } = principal.scope
    return (body.botId === undefined || body.botId === botId) &&
      (body.taskId === undefined || body.taskId === taskId)
      ? Effect.succeed({ botId, taskId })
      : Effect.fail(new ScopeViolation({ where: "policy.evaluate.subject" }))
  }
  return body.botId === undefined || body.taskId === undefined
    ? Effect.fail(new SchemaViolation({ where: "policy.evaluate", issue: "botId and taskId are required" }))
    : Effect.succeed({ botId: body.botId, taskId: body.taskId })
}

// deny and allow come from the Policy. On ask, an approved and unused approval of this task for this exact tool and
// input is spent (allow, once); otherwise a request is opened and the caller waits on it.
const evaluate = (principal: Principal, raw: unknown) =>
  Effect.gen(function* () {
    const body = yield* Schema.decodeUnknownEffect(EvaluateBody)(raw)
    const { botId, taskId } = yield* subjectOf(principal, body)
    const call: ToolCall = { tool: body.tool, input: body.input }
    const policy = yield* Policy
    const approvals = yield* Approvals
    if (principal.kind === "api" && body.cwd !== undefined && !policy.workspaceRoots.includes(body.cwd)) {
      return yield* Effect.fail(
        new SchemaViolation({
          where: "policy.evaluate.cwd",
          issue: "cwd is not a configured workspace root",
        }),
      )
    }
    const context = principal.kind === "api" && body.cwd !== undefined ? { cwd: body.cwd } : undefined
    const decision = yield* policy.evaluate(botId, call, context)
    if (decision.effect === "deny") {
      const reason = decision.rule?.reason ?? "Denied by policy."
      return { status: 200, body: { effect: "deny", reason } } satisfies RouteResponse
    }
    if (decision.effect === "allow") {
      return { status: 200, body: { effect: "allow" } } satisfies RouteResponse
    }
    const used = yield* approvals.consumeMatching(taskId, call)
    if (Option.isSome(used)) {
      return { status: 200, body: { effect: "allow", approvalId: used.value.id } } satisfies RouteResponse
    }
    const requested = yield* approvals.request({ taskId, botId, action: call, risk: decision.risk })
    return { status: 200, body: { effect: "ask", approvalId: requested.id } } satisfies RouteResponse
  }).pipe(Effect.catch(failureResponse))

export const parseTimeout = (raw: string | undefined): Effect.Effect<number, SchemaViolation> => {
  if (raw === undefined) return Effect.succeed(MAX_WAIT_MS)
  const ms = Number(raw)
  return Number.isInteger(ms) && ms >= 1
    ? Effect.succeed(Math.min(ms, MAX_WAIT_MS))
    : Effect.fail(
        new SchemaViolation({
          where: "approvals.wait.timeoutMs",
          issue: "timeoutMs must be an integer >= 1",
        }),
      )
}

// Polls the stored approval until it is decided or `timeoutMs` passes. A pending request past its expiry reads as
// expired here without being written: the sweep (ApprovalFlow.expireDue) owns the transition and closes the task.
export const waitForDecision = (id: ApprovalId, timeoutMs: number) =>
  Effect.gen(function* () {
    const approvals = yield* Approvals
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs
    const poll = (): Effect.Effect<string, NotFound | SqlError> =>
      Effect.gen(function* () {
        const record = yield* approvals.get(id)
        const now = yield* Clock.currentTimeMillis
        const status =
          record.status === "pending" && now >= record.expiresAt.epochMilliseconds ? "expired" : record.status
        if (status !== "pending" || now >= deadline) return status
        yield* Effect.sleep(Math.min(POLL_MS, deadline - now))
        return yield* poll()
      })
    return yield* poll()
  })

const wait = (principal: Principal, rawId: string, rawTimeout: string | undefined) =>
  Effect.gen(function* () {
    const id = yield* Schema.decodeUnknownEffect(ApprovalId)(rawId).pipe(
      Effect.mapError(() => new NotFound({ entity: "Approval", id: rawId })),
    )
    const timeoutMs = yield* parseTimeout(rawTimeout)
    const approvals = yield* Approvals
    // An execution token reads its own task's approvals; another task's, and an unknown id, look the same (403).
    const record = yield* approvals
      .get(id)
      .pipe(
        Effect.mapError((error) =>
          error._tag === "NotFound" && principal.kind === "execution"
            ? new ScopeViolation({ where: "approvals.wait" })
            : error,
        ),
      )
    if (principal.kind === "execution" && record.taskId !== principal.scope.taskId) {
      return yield* Effect.fail(new ScopeViolation({ where: "approvals.wait" }))
    }
    const status = yield* waitForDecision(id, timeoutMs)
    return { status: 200, body: { status } } satisfies RouteResponse
  }).pipe(Effect.catch(failureResponse))

// Neither route needs more: an evaluate body is a tool call, and wait has no body at all.
export const MAX_BODY_BYTES = 256 * 1024

// Reads the body up to the limit; undefined when it is larger (declared or streamed), so nothing big is buffered.
export const readLimitedBody = async (request: Request): Promise<string | undefined> => {
  const declared = Number(request.headers.get("content-length") ?? "0")
  if (declared > MAX_BODY_BYTES) return undefined
  const reader = request.body?.getReader()
  if (reader === undefined) return ""
  const chunks: Array<Uint8Array> = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BODY_BYTES) {
      await reader.cancel()
      return undefined
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString("utf8")
}

const TOO_LARGE = { error: "payload too large" }

export const registerPolicyRoutes = (app: Hono, runPolicy: RunPolicy): void => {
  app.post("/policy/evaluate", async (c) => {
    const principal = principalOf(c.req.raw)
    if (principal === undefined) return sendResponse(c, UNAUTHORIZED)
    const text = await readLimitedBody(c.req.raw)
    if (text === undefined) return c.json(TOO_LARGE, 413)
    let raw: unknown = null
    try {
      raw = JSON.parse(text)
    } catch {
      raw = null
    }
    return sendResponse(c, await runPolicy(evaluate(principal, raw)))
  })

  app.get("/approvals/:id/wait", async (c) => {
    const principal = principalOf(c.req.raw)
    if (principal === undefined) return sendResponse(c, UNAUTHORIZED)
    if ((await readLimitedBody(c.req.raw)) === undefined) return c.json(TOO_LARGE, 413)
    return sendResponse(c, await runPolicy(wait(principal, c.req.param("id"), c.req.query("timeoutMs"))))
  })
}
