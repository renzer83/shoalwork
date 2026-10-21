import { ExecutorProtocolError } from "@shoalwork/contracts"
import { Effect, Schema, Stream } from "effect"

const ToolCallDelta = Schema.Struct({
  index: Schema.optionalKey(Schema.Number),
  id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  function: Schema.optionalKey(
    Schema.Struct({
      name: Schema.optionalKey(Schema.NullOr(Schema.String)),
      arguments: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
})

export const Chunk = Schema.Struct({
  choices: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        delta: Schema.optionalKey(
          Schema.Struct({
            content: Schema.optionalKey(Schema.NullOr(Schema.String)),
            tool_calls: Schema.optionalKey(Schema.NullOr(Schema.Array(ToolCallDelta))),
          }),
        ),
        finish_reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  usage: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        prompt_tokens: Schema.optionalKey(Schema.Number),
        completion_tokens: Schema.optionalKey(Schema.Number),
      }),
    ),
  ),
  // Some gateways (OpenRouter) report a mid-stream failure as a chunk with an error object; null means none.
  error: Schema.optionalKey(Schema.Unknown),
})
export type Chunk = typeof Chunk.Type

const MAX_LINE_CHARS = 300
const DATA_PREFIX = "data:"
const DONE = "[DONE]"
const NEWLINE = 10

// The endpoint is untrusted: bytes are counted before any line splitting or decoding buffers them.
export const MAX_LINE_BYTES = 1024 * 1024
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

export type SseLimits = { readonly maxLineBytes: number; readonly maxResponseBytes: number }

const DEFAULT_LIMITS: SseLimits = { maxLineBytes: MAX_LINE_BYTES, maxResponseBytes: MAX_RESPONSE_BYTES }

// Fails when one line (bytes since the last \n, across chunks) or the whole response goes over its limit.
const limitBytes = (
  bytes: Stream.Stream<Uint8Array, ExecutorProtocolError>,
  limits: SseLimits,
  fail: (why: string) => ExecutorProtocolError,
): Stream.Stream<Uint8Array, ExecutorProtocolError> =>
  Stream.suspend(() => {
    let total = 0
    let line = 0
    return bytes.pipe(
      Stream.mapEffect((chunk) => {
        total += chunk.length
        if (total > limits.maxResponseBytes) return Effect.fail(fail("response is over the size limit"))
        let start = 0
        for (let at = chunk.indexOf(NEWLINE); at !== -1; at = chunk.indexOf(NEWLINE, start)) {
          line += at - start
          if (line > limits.maxLineBytes) return Effect.fail(fail("line is over the size limit"))
          line = 0
          start = at + 1
        }
        line += chunk.length - start
        return line > limits.maxLineBytes
          ? Effect.fail(fail("line is over the size limit"))
          : Effect.succeed(chunk)
      }),
    )
  })

// SSE `data:` lines up to `[DONE]` (reported through onDone); comments and other fields are skipped. A bad payload or
// a limit hit is a protocol error.
export const chunksOf = (
  response: Response,
  executor: string,
  onDone: () => void = () => undefined,
  limits: SseLimits = DEFAULT_LIMITS,
): Stream.Stream<Chunk, ExecutorProtocolError> => {
  const decode = Schema.decodeUnknownEffect(Chunk)
  const fail = (line: string, cause: unknown) =>
    new ExecutorProtocolError({ executor, line: line.slice(0, MAX_LINE_CHARS), cause })
  const body = response.body
  if (body === null) return Stream.fail(fail("", "response has no body"))
  const raw = Stream.fromReadableStream({ evaluate: () => body, onError: (cause) => fail("", cause) })
  return limitBytes(raw, limits, (why) => fail("", why)).pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => line.startsWith(DATA_PREFIX)),
    Stream.map((line) => line.slice(DATA_PREFIX.length).trim()),
    Stream.tap((payload) =>
      Effect.sync(() => {
        if (payload === DONE) onDone()
      }),
    ),
    Stream.takeWhile((payload) => payload !== DONE),
    Stream.filter((payload) => payload !== ""),
    Stream.mapEffect((payload) =>
      Effect.try({ try: (): unknown => JSON.parse(payload), catch: (cause) => fail(payload, cause) }).pipe(
        Effect.flatMap((value) => decode(value).pipe(Effect.mapError((cause) => fail(payload, cause)))),
      ),
    ),
  )
}
