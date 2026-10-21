import type { ExecutorErrorCode } from "@shoalwork/contracts"
import { Data, type Duration, Effect, Redacted, Schedule, type Scope } from "effect"

// Minimal client for POST <baseUrl>/chat/completions with stream:true (OpenAI-style SSE), over the native fetch.

export type ToolDef = {
  readonly type: "function"
  readonly function: {
    readonly name: string
    readonly description: string
    readonly parameters: Readonly<Record<string, unknown>>
  }
}

export type ToolCallMsg = {
  readonly id: string
  readonly type: "function"
  readonly function: { readonly name: string; readonly arguments: string }
}

export type ChatMessage =
  | { readonly role: "system" | "user"; readonly content: string }
  | {
      readonly role: "assistant"
      readonly content: string | null
      readonly tool_calls?: ReadonlyArray<ToolCallMsg>
    }
  | { readonly role: "tool"; readonly tool_call_id: string; readonly content: string }

export type FetchLike = (
  url: string,
  init: {
    readonly method: string
    readonly headers: Record<string, string>
    readonly body: string
    readonly signal: AbortSignal
  },
) => Promise<Response>

export type ChatRequest = {
  readonly baseUrl: string
  readonly apiKey?: Redacted.Redacted<string> | undefined
  readonly model: string
  readonly messages: ReadonlyArray<ChatMessage>
  readonly tools?: ReadonlyArray<ToolDef> | undefined
  readonly maxTokens: number
  readonly includeUsage: boolean
}

// Failure to get a streaming response. `status` is 0 when the request never got one.
export class ChatRequestError extends Data.TaggedError("ChatRequestError")<{
  readonly status: number
  readonly code: ExecutorErrorCode
  readonly message: string
  // The error body names stream_options: the server refuses usage in streams.
  readonly streamOptionsRefused?: boolean
}> {}

// The key Ollama and friends ignore but some clients insist on sending.
const PLACEHOLDER_KEY = "ollama"
const ERROR_BODY_CHARS = 300
const ERROR_BODY_READ_BYTES = 4096

const isRetryable = (error: ChatRequestError): boolean => error.status === 429 || error.status >= 500

const endpoint = (baseUrl: string): string => `${baseUrl.replace(/\/+$/, "")}/chat/completions`

const keyOf = (req: ChatRequest): string =>
  req.apiKey === undefined ? PLACEHOLDER_KEY : Redacted.value(req.apiKey)

// Error text never carries the key, whatever the server echoes back.
const scrub = (text: string, req: ChatRequest): string => {
  const key = keyOf(req)
  const clipped = text.slice(0, ERROR_BODY_CHARS)
  return key === "" ? clipped : clipped.split(key).join("[redacted]")
}

const describe = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

const bodyOf = (req: ChatRequest): string =>
  JSON.stringify({
    model: req.model,
    messages: req.messages,
    stream: true,
    max_tokens: req.maxTokens,
    ...(req.includeUsage ? { stream_options: { include_usage: true } } : {}),
    ...(req.tools === undefined || req.tools.length === 0 ? {} : { tools: req.tools }),
  })

// At most `max` bytes of the body, then the rest is cancelled: an error page from an endpoint is never read whole.
const readHead = async (response: Response, max: number): Promise<string> => {
  const reader = response.body?.getReader()
  if (reader === undefined) return ""
  const parts: Array<Uint8Array> = []
  let size = 0
  try {
    while (size < max) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
      size += value.length
    }
  } catch {
    // an unreadable error body is reported by its status alone
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return new TextDecoder().decode(Buffer.concat(parts).subarray(0, max))
}

const sendOnce = (
  fetcher: FetchLike,
  req: ChatRequest,
): Effect.Effect<Response, ChatRequestError, Scope.Scope> =>
  Effect.gen(function* () {
    const controller = yield* Effect.acquireRelease(
      Effect.sync(() => new AbortController()),
      (c) => Effect.sync(() => c.abort()),
    )
    const response = yield* Effect.tryPromise({
      try: () =>
        fetcher(endpoint(req.baseUrl), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "text/event-stream",
            authorization: `Bearer ${keyOf(req)}`,
          },
          body: bodyOf(req),
          signal: controller.signal,
        }),
      catch: (cause) =>
        new ChatRequestError({
          status: 0,
          code: "unknown",
          message: scrub(`request failed: ${describe(cause)}`, req),
        }),
    })
    if (response.ok) return response
    const text = yield* Effect.promise(() => readHead(response, ERROR_BODY_READ_BYTES))
    return yield* Effect.fail(
      new ChatRequestError({
        status: response.status,
        code: response.status === 401 || response.status === 403 ? "auth" : "unknown",
        message: scrub(`HTTP ${response.status}: ${text}`, req),
        streamOptionsRefused: /stream_options/i.test(text),
      }),
    )
  })

// 429 and 5xx are retried twice with exponential backoff. A 400 that names stream_options is retried once without it
// (`onUsageRefused` lets the caller remember that for the rest of the run); usage is then estimated.
export const openChat = (
  fetcher: FetchLike,
  req: ChatRequest,
  retryBase: Duration.Input,
  onUsageRefused: () => void = () => undefined,
): Effect.Effect<Response, ChatRequestError, Scope.Scope> => {
  const attempt = (r: ChatRequest) =>
    sendOnce(fetcher, r).pipe(
      Effect.retry({
        schedule: Schedule.exponential(retryBase),
        times: 2,
        while: isRetryable,
      }),
    )
  return attempt(req).pipe(
    Effect.catchIf(
      (error) => req.includeUsage && error.status === 400 && error.streamOptionsRefused === true,
      () => Effect.sync(onUsageRefused).pipe(Effect.andThen(attempt({ ...req, includeUsage: false }))),
    ),
  )
}
