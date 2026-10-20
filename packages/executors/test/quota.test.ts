import { ExecutorId, type Usage } from "@shoalwork/contracts"
import { DateTime, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { makeQuotaCounter } from "../src/quota.js"

const executor = Schema.decodeUnknownSync(ExecutorId)("claude-code")

const usage = (tokensIn: number, tokensOut: number): Usage => ({
  tokensIn,
  tokensOut,
  cacheRead: 0,
  cacheWrite: 0,
  usd: 0,
  seconds: 0,
})

const START_MS = 1_000_000
const WINDOW_SECONDS = 60

describe("makeQuotaCounter", () => {
  it("becomes unavailable once the soft limit is reached", () => {
    const clock = START_MS
    const counter = makeQuotaCounter(executor, WINDOW_SECONDS, 100, () => clock)
    counter.record(usage(30, 30))
    expect(counter.status()).toMatchObject({ executor, usedRatio: 0.6, available: true })
    counter.record(usage(20, 20))
    expect(counter.status()).toMatchObject({ usedRatio: 1, available: false })
    counter.record(usage(50, 50))
    expect(counter.status()).toMatchObject({ usedRatio: 1, available: false })
  })

  it("becomes available again when the window expires", () => {
    let clock = START_MS
    const counter = makeQuotaCounter(executor, WINDOW_SECONDS, 100, () => clock)
    counter.record(usage(100, 0))
    expect(counter.status().available).toBe(false)

    clock = START_MS + WINDOW_SECONDS * 1000 - 1
    expect(counter.status().available).toBe(false)

    clock = START_MS + WINDOW_SECONDS * 1000
    const status = counter.status()
    expect(status).toMatchObject({ usedRatio: 0, available: true })
    expect(status).not.toHaveProperty("windowEndsAt")
  })

  it("reports windowEndsAt while the window is open", () => {
    let clock = START_MS
    const counter = makeQuotaCounter(executor, WINDOW_SECONDS, 100, () => clock)
    counter.record(usage(10, 10))
    clock = START_MS + 5_000
    const status = counter.status()
    expect(status.windowEndsAt).toBeDefined()
    expect(DateTime.toEpochMillis(status.windowEndsAt ?? DateTime.makeUnsafe(0))).toBe(
      START_MS + WINDOW_SECONDS * 1000,
    )
  })
})
