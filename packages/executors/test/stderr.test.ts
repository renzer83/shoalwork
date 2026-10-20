import { it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { describe, expect } from "vitest"
import { captureStderr, redactStderr, STDERR_TAIL_CHARS } from "../src/stderr.js"

describe("redactStderr", () => {
  it.each([
    ["fetch https://user:pass@host.test/x", "fetch https://***@host.test/x"],
    ["API_KEY=abc", "[redacted]"],
    ["session token issued", "[redacted]"],
    ["SECRET=shh", "[redacted]"],
    ["Password rejected for user", "[redacted]"],
    ["see https://host.test/docs", "see https://host.test/docs"],
    ["plain warning", "plain warning"],
  ])("redacts %j to %j", (raw, expected) => {
    expect(redactStderr(raw)).toBe(expected)
  })

  it("applies the line rule and the URL rule line by line", () => {
    expect(redactStderr("ok line\ntoken=1\nclone https://u:p@h.test/r")).toBe(
      "ok line\n[redacted]\nclone https://***@h.test/r",
    )
  })
})

describe("captureStderr", () => {
  it.effect("keeps only the last STDERR_TAIL_CHARS characters of stderr", () =>
    Effect.gen(function* () {
      const lines = Array.from({ length: 2000 }, (_, index) => `line-${index}`)
      const tail = yield* Effect.scoped(
        Effect.gen(function* () {
          const read = yield* captureStderr(Stream.fromIterable(lines))
          return yield* read
        }),
      )
      expect(tail.length).toBeLessThanOrEqual(STDERR_TAIL_CHARS)
      expect(tail.endsWith("line-1999")).toBe(true)
    }),
  )

  it.live("returns what arrived when stderr never closes, after the short wait", () =>
    Effect.gen(function* () {
      const stderr = Stream.concat(Stream.make("partial"), Stream.never)
      const tail = yield* Effect.scoped(
        Effect.gen(function* () {
          const read = yield* captureStderr(stderr)
          return yield* read
        }),
      )
      expect(tail).toBe("partial")
    }),
  )
})
