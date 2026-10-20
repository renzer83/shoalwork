import { Data, Effect, type Redacted, Redacted as RedactedApi, Schema } from "effect"

// The bridge process never opens the database: it asks the core over HTTP with the run's execution token
// (02-architecture §7, §12), so it works inside any Tank.
export class BridgeApiError extends Data.TaggedError("BridgeApiError")<{
  readonly op: string
  readonly reason: string
}> {}

export const EvaluateResult = Schema.Struct({
  effect: Schema.Literals(["allow", "deny", "ask"]),
  approvalId: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
})
export type EvaluateResult = typeof EvaluateResult.Type

export const WaitResult = Schema.Struct({
  status: Schema.Literals(["pending", "approved", "denied", "expired"]),
})
export type WaitResult = typeof WaitResult.Type

export interface EvaluateCall {
  readonly tool: string
  readonly input: unknown
}

export interface BridgeApi {
  readonly evaluate: (call: EvaluateCall) => Effect.Effect<EvaluateResult, BridgeApiError>
  // One long-poll: the core answers within `timeoutMs` (it caps it at 60 s).
  readonly wait: (approvalId: string, timeoutMs: number) => Effect.Effect<WaitResult, BridgeApiError>
}

export interface BridgeApiOptions {
  // Origin of the core, validated by the entrypoint.
  readonly baseUrl: string
  readonly token: Redacted.Redacted<string>
  readonly fetch?: typeof globalThis.fetch
}

const EVALUATE_TIMEOUT_MS = 10_000
// Slack on top of the long-poll slice: the request may take the whole slice plus a database read.
const WAIT_SLACK_MS = 10_000
const MAX_BODY_BYTES = 65_536
// Ids minted by the core (`apr_<uuid v4>`); anything else never becomes a path segment.
export const APPROVAL_ID_PATTERN = /^apr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const decodeEvaluate = Schema.decodeUnknownEffect(EvaluateResult)
const decodeWait = Schema.decodeUnknownEffect(WaitResult)

// Reads the body in chunks and stops at the cap, so a big answer is never held in memory. Undefined: over the cap.
const readCapped = async (response: Response): Promise<Uint8Array | undefined> => {
  const reader = response.body?.getReader()
  if (reader === undefined) return new Uint8Array()
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
  return Buffer.concat(chunks)
}

const networkReason = (cause: unknown): string =>
  cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError")
    ? "timeout"
    : "network error"

// Every failure becomes a BridgeApiError with a short reason. The response body and the token never go into it.
export const makeBridgeApi = (options: BridgeApiOptions): BridgeApi => {
  const doFetch = options.fetch ?? globalThis.fetch
  const authorization = `Bearer ${RedactedApi.value(options.token)}`

  const request = (
    op: string,
    url: URL,
    init: { readonly method: "GET" | "POST"; readonly body?: string; readonly timeoutMs: number },
  ): Effect.Effect<unknown, BridgeApiError> =>
    Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: () =>
          doFetch(url, {
            method: init.method,
            headers: {
              authorization,
              ...(init.body === undefined ? {} : { "content-type": "application/json" }),
            },
            ...(init.body === undefined ? {} : { body: init.body }),
            signal: AbortSignal.timeout(init.timeoutMs),
          }),
        catch: (cause) => new BridgeApiError({ op, reason: networkReason(cause) }),
      })
      if (!response.ok) {
        return yield* Effect.fail(new BridgeApiError({ op, reason: `HTTP ${response.status}` }))
      }
      const declared = Number(response.headers.get("content-length") ?? "0")
      if (declared > MAX_BODY_BYTES) {
        return yield* Effect.fail(new BridgeApiError({ op, reason: "response too large" }))
      }
      const buffer = yield* Effect.tryPromise({
        try: () => readCapped(response),
        catch: (cause) => new BridgeApiError({ op, reason: networkReason(cause) }),
      })
      if (buffer === undefined) {
        return yield* Effect.fail(new BridgeApiError({ op, reason: "response too large" }))
      }
      return yield* Effect.try({
        try: (): unknown => JSON.parse(new TextDecoder().decode(buffer)),
        catch: () => new BridgeApiError({ op, reason: "invalid JSON" }),
      })
    })

  const shapeError = (op: string) => () => new BridgeApiError({ op, reason: "unexpected response shape" })

  return {
    evaluate: (call) =>
      request("evaluate", new URL("/policy/evaluate", options.baseUrl), {
        method: "POST",
        body: JSON.stringify({ tool: call.tool, input: call.input }),
        timeoutMs: EVALUATE_TIMEOUT_MS,
      }).pipe(Effect.flatMap((body) => decodeEvaluate(body).pipe(Effect.mapError(shapeError("evaluate"))))),
    wait: (approvalId, timeoutMs) => {
      if (!APPROVAL_ID_PATTERN.test(approvalId)) {
        return Effect.fail(new BridgeApiError({ op: "wait", reason: "invalid approval id" }))
      }
      const url = new URL(`/approvals/${approvalId}/wait`, options.baseUrl)
      url.searchParams.set("timeoutMs", String(timeoutMs))
      return request("wait", url, { method: "GET", timeoutMs: timeoutMs + WAIT_SLACK_MS }).pipe(
        Effect.flatMap((body) => decodeWait(body).pipe(Effect.mapError(shapeError("wait")))),
      )
    },
  }
}
