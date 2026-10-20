import { ExecutorProtocolError } from "@shoalwork/contracts"
import { Effect, Schema, Stream } from "effect"

// Long lines are cut before going into an error: adapter output can be big and may carry sensitive text.
const MAX_LINE_CHARS = 300

const clip = (line: string): string => (line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) : line)

// Blank lines are skipped. Non-JSON or schema-invalid lines fail the stream with ExecutorProtocolError.
export const parseNdjsonLines = <A>(schema: Schema.Codec<A, unknown>, executor: string) => {
  const decode = Schema.decodeUnknownEffect(schema)
  const parseLine = (line: string): Effect.Effect<A, ExecutorProtocolError> =>
    Effect.try({
      try: (): unknown => JSON.parse(line),
      catch: (cause) => new ExecutorProtocolError({ executor, line: clip(line), cause }),
    }).pipe(
      Effect.flatMap((value) =>
        decode(value).pipe(
          Effect.mapError((cause) => new ExecutorProtocolError({ executor, line: clip(line), cause })),
        ),
      ),
    )
  return <E>(lines: Stream.Stream<string, E>): Stream.Stream<A, E | ExecutorProtocolError> =>
    lines.pipe(
      Stream.filter((line) => line.trim() !== ""),
      Stream.mapEffect(parseLine),
    )
}
