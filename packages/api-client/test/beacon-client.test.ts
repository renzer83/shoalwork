import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { ApiClient, EventFeed, SavingsReport } from "../src/index.js"

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })

const SAVINGS = {
  decisions: { total: 4, rule: 2, cache: 1, model: 1, localPct: 75 },
  haikuRuns: 2,
  decisionUsd: 0.03,
  avoidedUsd: 0.09,
  context: {
    assembled: 1,
    tokensBefore: 1000,
    tokensAfter: 600,
    tokensCut: 400,
    cutPct: 40,
    droppedItems: 3,
    usdPerInputToken: 0.0001,
    avoidedUsd: 0.04,
  },
}

describe("beacon client", () => {
  it("sends the window and filters as query parameters and decodes the savings body", async () => {
    const seen: Array<string> = []
    const client = new ApiClient(
      "http://core.test",
      async () => null,
      async (input) => {
        seen.push(String(input))
        return json(SAVINGS)
      },
    )
    const body = await Schema.decodeUnknownPromise(SavingsReport)(SAVINGS)
    expect(body.decisions.localPct).toBe(75)
    const result = await Effect.runPromise(
      client.beacon.savings({ since: "7d", until: "2026-10-21T00:00:00.000Z" }),
    )
    expect(result.context.tokensCut).toBe(400)
    expect(seen[0]).toBe("http://core.test/beacon/savings?since=7d&until=2026-10-21T00%3A00%3A00.000Z")
  })

  it("rejects an events body whose cursor is not a number or null", async () => {
    await expect(Schema.decodeUnknownPromise(EventFeed)({ events: [], nextBefore: "4" })).rejects.toThrow()
    await expect(Schema.decodeUnknownPromise(EventFeed)({ events: [], nextBefore: null })).resolves.toEqual({
      events: [],
      nextBefore: null,
    })
  })
})
