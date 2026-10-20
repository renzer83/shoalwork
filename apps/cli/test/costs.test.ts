import { it } from "@effect/vitest"
import { SchemaViolation } from "@shoalwork/contracts"
import { Effect } from "effect"
import { afterEach, describe, expect, vi } from "vitest"
import { UsageError } from "../src/args.js"
import { costsQuery, costsReport, renderCosts } from "../src/commands/costs.js"

const SETTINGS = { url: "http://localhost:28900", token: "dev-token" }

const BODY = {
  rows: [
    {
      key: "task_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      n: 3,
      tokensIn: 1200,
      tokensOut: 90,
      usd: 0.1234,
      contextTokensAvg: 410.6,
      okRate: 0.6667,
    },
    {
      key: "task_1b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e",
      n: 1,
      tokensIn: 0,
      tokensOut: 0,
      usd: 0,
      contextTokensAvg: null,
      okRate: 0,
    },
  ],
  delta: { tokensInPct: -12.5, okRatePct: null },
}

const stubFetch = (body: unknown, status = 200) => {
  const mock = vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  )
  vi.stubGlobal("fetch", mock)
  return mock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("costsQuery", () => {
  it.effect("maps --since and --compare to since and compareWith, defaulting by to task", () =>
    Effect.gen(function* () {
      const query = yield* costsQuery({ since: "7d", compare: "14d" })
      expect(query.toString()).toBe("by=task&since=7d&compareWith=14d")
    }),
  )

  it.effect("rejects an unknown --by before any request", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(costsQuery({ by: "day" }))
      expect(failure).toBeInstanceOf(UsageError)
    }),
  )
})

describe("costsReport", () => {
  it.effect("requests GET /costs with the query and decodes the body", () =>
    Effect.gen(function* () {
      const mock = stubFetch(BODY)
      const body = yield* costsReport(SETTINGS, { by: "bot", since: "7d", compare: "14d" })
      expect(body.rows).toHaveLength(2)
      const [url, init] = mock.mock.calls[0] ?? []
      expect(String(url)).toBe("http://localhost:28900/costs?by=bot&since=7d&compareWith=14d")
      expect(init?.headers).toMatchObject({ authorization: "Bearer dev-token" })
    }),
  )

  it.effect("rejects a body without the delta block as a schema violation", () =>
    Effect.gen(function* () {
      stubFetch({ rows: [] })
      const failure = yield* Effect.flip(costsReport(SETTINGS, {}))
      expect(failure).toBeInstanceOf(SchemaViolation)
    }),
  )
})

describe("renderCosts", () => {
  it("prints a table with one line per row and n/d for a delta with no baseline", () => {
    const text = renderCosts({ rows: BODY.rows, delta: { tokensInPct: -12.5, okRatePct: null } }, false)
    const lines = text.split("\n")
    expect(lines[0]).toMatch(/^key\s+n\s+tokensIn\s+tokensOut\s+usd\s+ctxAvg\s+okRate$/)
    expect(lines[1]).toContain("task_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d")
    expect(lines[1]).toContain("0.1234")
    expect(lines[1]).toContain("411")
    expect(lines[1]).toContain("66.7%")
    expect(lines[2]).toContain("-")
    expect(text).toContain("tokensIn per execution vs baseline: -12.5%")
    expect(text).toContain("okRate vs baseline: n/d")
  })

  it("prints n/d for both deltas when there is no baseline", () => {
    const text = renderCosts({ rows: [], delta: { tokensInPct: null, okRatePct: null } }, false)
    expect(text).toContain("no executions in the window")
    expect(text).toContain("tokensIn per execution vs baseline: n/d")
    expect(text).toContain("okRate vs baseline: n/d")
  })

  it("prints the body as JSON with --json", () => {
    const text = renderCosts(BODY, true)
    expect(JSON.parse(text)).toEqual(BODY)
  })
})
