import { Clock, Effect } from "effect"
import type { BridgeApi } from "./api.js"

// What the CLI hands to the permission tool (shape from the SDK docs; confirmed by the probe fixture, T-166).
export interface PermissionRequest {
  readonly tool_name: string
  readonly input: Readonly<Record<string, unknown>>
  readonly tool_use_id?: string | undefined
}

export type PermissionVerdict =
  | { readonly behavior: "allow"; readonly updatedInput: Readonly<Record<string, unknown>> }
  | { readonly behavior: "deny"; readonly message: string }

// "inline": hold the CLI on the tool until a person decides. "resume": the T-054 path, an ask denies at once with a
// message and the Lead resumes the session after the decision.
export type BridgeMode = "inline" | "resume"

export interface DecideOptions {
  readonly mode: BridgeMode
  // APPROVAL_TIMEOUT_MS: how long one call may stay blocked, counted once from the start of the decision.
  readonly approvalTimeoutMs: number
  // One long-poll to the core; the core caps it at 60 s.
  readonly waitSliceMs: number
}

export const APPROVAL_TIMEOUT_MS = 7_200_000
export const WAIT_SLICE_MS = 60_000
const MAX_WAIT_ERRORS = 3
const RETRY_PAUSE_MS = 1_000

const allow = (request: PermissionRequest): PermissionVerdict => ({
  behavior: "allow",
  updatedInput: request.input,
})

const deny = (message: string): PermissionVerdict => ({ behavior: "deny", message })

type Waited = "approved" | "denied" | "expired" | "unavailable"

// Long-poll until the approval is decided or the deadline passes. Transient failures retry a few times, then fail closed.
const waitForDecision = (
  api: BridgeApi,
  approvalId: string,
  deadline: number,
  options: DecideOptions,
  errors = 0,
): Effect.Effect<Waited> =>
  Effect.gen(function* () {
    const remaining = deadline - (yield* Clock.currentTimeMillis)
    if (remaining <= 0) return "expired" as const
    const outcome = yield* api.wait(approvalId, Math.min(options.waitSliceMs, remaining)).pipe(
      Effect.map((result) => result.status),
      Effect.catch(() => Effect.succeed("error" as const)),
    )
    if (outcome === "pending") return yield* waitForDecision(api, approvalId, deadline, options, 0)
    if (outcome !== "error") return outcome
    if (errors + 1 >= MAX_WAIT_ERRORS) return "unavailable" as const
    yield* Effect.sleep(RETRY_PAUSE_MS)
    return yield* waitForDecision(api, approvalId, deadline, options, errors + 1)
  })

const evaluateCall = (api: BridgeApi, request: PermissionRequest) =>
  api.evaluate({ tool: request.tool_name, input: request.input }).pipe(Effect.option)

// Never fails: every problem is a deny, so the CLI never runs a call the core did not allow.
export const decidePermission = (
  api: BridgeApi,
  request: PermissionRequest,
  options: DecideOptions,
): Effect.Effect<PermissionVerdict> =>
  Effect.gen(function* () {
    // One deadline for the whole call, taken before the first request.
    const deadline = (yield* Clock.currentTimeMillis) + options.approvalTimeoutMs
    const first = yield* evaluateCall(api, request)
    if (first._tag === "None") return deny("Permission check is unavailable; the call was not allowed.")
    const result = first.value
    if (result.effect === "allow") return allow(request)
    if (result.effect === "deny") return deny(result.reason ?? "Denied by policy.")
    if (result.approvalId === undefined) return deny("Approval could not be requested.")
    if (options.mode === "resume")
      return deny("Paused for approval; the task will resume once it is decided.")
    const decision = yield* waitForDecision(api, result.approvalId, deadline, options)
    switch (decision) {
      case "denied":
        return deny("Approval was denied.")
      case "expired":
        return deny("Approval expired without an answer.")
      case "unavailable":
        return deny("Approval status is unavailable; the call was not allowed.")
      // The approval is only a ticket: the core spends it when it evaluates this exact call again. Only an allow
      // opens the call; a second ask (another call took the ticket) is a deny, never a new wait.
      case "approved": {
        const again = yield* evaluateCall(api, request)
        return again._tag === "Some" && again.value.effect === "allow"
          ? allow(request)
          : deny("The approval no longer covers this call.")
      }
    }
  }).pipe(Effect.catchCause(() => Effect.succeed(deny("Permission check failed; the call was not allowed."))))
