import { it } from "@effect/vitest"
import { type ExecutorEvent, ExecutorId, type Usage } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import { SqlError, UnknownError } from "effect/sql/SqlError"
import { describe, expect } from "vitest"
import { limitSignalOf, observeQuota } from "../../src/quota/signals.js"
import type { QuotaStoreShape } from "../../src/quota/store.js"

const claude = Schema.decodeUnknownSync(ExecutorId)("claude-code")

const usage: Usage = { tokensIn: 3, tokensOut: 4, cacheRead: 0, cacheWrite: 0, usd: 0.01, seconds: 1 }

// SYNTHETIC limit texts: no real limit text has been captured yet (UNVERIFIED, see 06-research/claude-code.md §10).
// The not-logged-in text is real: it is the raw result of fixtures/claude-code/2.1.304/not-logged-in.ndjson.
describe("limitSignalOf", () => {
  it("classifies a text naming HTTP 429 as the 429 source", () => {
    expect(limitSignalOf("API Error: 429 Too Many Requests")).toBe("429")
  })

  it("classifies a text naming a usage limit as the limit_text source", () => {
    expect(limitSignalOf("Usage limit reached for this subscription")).toBe("limit_text")
    expect(limitSignalOf("rate limit exceeded, try later")).toBe("limit_text")
  })

  it("names no limit for the real not-logged-in text", () => {
    expect(limitSignalOf("Not logged in · Please run /login")).toBeUndefined()
  })

  it("names no limit for an ordinary failure text", () => {
    expect(limitSignalOf("error_max_turns")).toBeUndefined()
    expect(limitSignalOf("")).toBeUndefined()
  })

  it("classifies HTTP 429 and limit phrases in error texts", () => {
    expect(limitSignalOf("HTTP 429 Too Many Requests")).toBe("429")
    expect(limitSignalOf("usage limit reached")).toBe("limit_text")
    expect(limitSignalOf("quota exceeded for this plan")).toBe("limit_text")
  })

  // Negatives from a real failure: a stack-trace position, a pid, a disk quota, a port that merely contains 429.
  it("does not mistake a stack position, a pid, a disk quota or a longer number for a limit", () => {
    expect(limitSignalOf("TypeError at file:///app/x.js:429:12")).toBeUndefined()
    expect(limitSignalOf("exited with code 1 (pid 14290)")).toBeUndefined()
    expect(limitSignalOf("ENOSPC: disk quota")).toBeUndefined()
    expect(limitSignalOf("listen failed on port 4290")).toBeUndefined()
  })
})

// A store that only logs its calls, for checking what the observer hands it.
const recordingStore = () => {
  const calls: Array<string> = []
  const store: QuotaStoreShape = {
    record: (executor, used) =>
      Effect.sync(() => {
        calls.push(`record ${executor} ${used.tokensIn + used.tokensOut}`)
      }),
    markExhausted: (executor, source) =>
      Effect.sync(() => {
        calls.push(`exhausted ${executor} ${source}`)
      }),
    setExhaustedUntil: () => Effect.void,
    hasWindow: () => true,
    status: (executor) => Effect.succeed({ executor, usedRatio: 0, available: true }),
  }
  return { store, calls }
}

describe("observeQuota", () => {
  it.effect("records usage events", () =>
    Effect.gen(function* () {
      const { store, calls } = recordingStore()
      const event: ExecutorEvent = { kind: "usage", usage }
      yield* observeQuota(store, claude)(event)
      expect(calls).toEqual(["record claude-code 7"])
    }),
  )

  it.effect("marks the executor exhausted on an error that names a limit", () =>
    Effect.gen(function* () {
      const { store, calls } = recordingStore()
      yield* observeQuota(
        store,
        claude,
      )({ kind: "error", code: "unknown", message: "API Error: 429 slow down" })
      expect(calls).toEqual(["exhausted claude-code 429"])
    }),
  )

  it.effect("never marks the executor from the result of a successful run", () =>
    Effect.gen(function* () {
      const { store, calls } = recordingStore()
      yield* observeQuota(
        store,
        claude,
      )({ kind: "done", result: "usage limit reached, see docs", artifacts: [] })
      expect(calls).toEqual([])
    }),
  )

  it.effect("ignores an auth error that names no limit and errors of other codes", () =>
    Effect.gen(function* () {
      const { store, calls } = recordingStore()
      const observe = observeQuota(store, claude)
      yield* observe({ kind: "error", code: "auth", message: "claude CLI is not logged in" })
      yield* observe({ kind: "error", code: "budget", message: "usage limit of the run exceeded" })
      yield* observe({ kind: "done", result: "ok", artifacts: [] })
      expect(calls).toEqual([])
    }),
  )

  it.effect("does nothing without a store", () =>
    Effect.gen(function* () {
      yield* observeQuota(undefined, claude)({ kind: "usage", usage })
      yield* observeQuota(undefined, claude)({ kind: "error", code: "unknown", message: "rate limit" })
    }),
  )

  it.effect("logs a failing store instead of failing the run", () =>
    Effect.gen(function* () {
      const failing: QuotaStoreShape = {
        record: () =>
          Effect.fail(new SqlError({ reason: new UnknownError({ message: "db busy", cause: "busy" }) })),
        markExhausted: () =>
          Effect.fail(new SqlError({ reason: new UnknownError({ message: "db busy", cause: "busy" }) })),
        setExhaustedUntil: () => Effect.void,
        hasWindow: () => true,
        status: (executor) => Effect.succeed({ executor, usedRatio: 0, available: true }),
      }
      yield* observeQuota(failing, claude)({ kind: "usage", usage })
      yield* observeQuota(failing, claude)({ kind: "error", code: "unknown", message: "usage limit" })
    }),
  )
})
