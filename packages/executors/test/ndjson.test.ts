import { it } from "@effect/vitest"
import { ExecutorProtocolError } from "@shoalwork/contracts"
import { Effect, Schema, Stream } from "effect"
import { describe, expect } from "vitest"
import { parseNdjsonLines } from "../src/ndjson.js"

const Line = Schema.Struct({ kind: Schema.String, n: Schema.Int })
type Line = typeof Line.Type

const parse = parseNdjsonLines(Line, "fake-executor")
const lines = (...values: ReadonlyArray<string>) => Stream.fromIterable(values)

describe("parseNdjsonLines", () => {
  it.effect("emits valid lines, skips blank ones, then fails with ExecutorProtocolError on a bad line", () =>
    Effect.gen(function* () {
      const values: Array<Line> = []
      const error = yield* Stream.runForEach(
        parse(lines('{"kind":"a","n":1}', '{"kind":"b","n":2}', '{"kind":"c","n":3}', "", "not json")),
        (value) =>
          Effect.sync(() => {
            values.push(value)
          }),
      ).pipe(Effect.flip)
      expect(values).toEqual([
        { kind: "a", n: 1 },
        { kind: "b", n: 2 },
        { kind: "c", n: 3 },
      ])
      expect(error).toBeInstanceOf(ExecutorProtocolError)
      expect(error.line).toBe("not json")
      expect(error.executor).toBe("fake-executor")
    }),
  )

  it.effect("rejects a JSON line that does not match the schema and clips the line to 300 chars", () =>
    Effect.gen(function* () {
      const schemaMiss = yield* Stream.runCollect(parse(lines('{"kind":"x"}'))).pipe(Effect.flip)
      expect(schemaMiss).toBeInstanceOf(ExecutorProtocolError)
      expect(schemaMiss.line).toBe('{"kind":"x"}')

      const longGarbage = "z".repeat(1000)
      const clipped = yield* Stream.runCollect(parse(lines(longGarbage))).pipe(Effect.flip)
      expect(clipped).toBeInstanceOf(ExecutorProtocolError)
      expect(clipped.line).toHaveLength(300)
    }),
  )

  it.effect("a stream of only blank lines yields nothing and no error", () =>
    Effect.gen(function* () {
      const values = yield* Stream.runCollect(parse(lines("", "   ", "\t")))
      expect(values).toEqual([])
    }),
  )
})
