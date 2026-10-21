import { it } from "@effect/vitest"
import { QuotaStatus } from "@shoalwork/contracts"
import { Console, Effect, Schema } from "effect"
import { afterEach, beforeEach, describe, expect, vi } from "vitest"
import { UsageError } from "../src/args.js"
import {
  executorCommand,
  exhaustedUntilBody,
  quotaList,
  quotaSet,
  renderQuota,
} from "../src/commands/executor.js"

const SETTINGS = { url: "http://localhost:28900", token: "dev-token" }
const FUTURE_MS = Date.now() + 3 * 60 * 60 * 1000
const FUTURE = new Date(FUTURE_MS).toISOString()

const QUOTAS = {
  quotas: [
    { executor: "claude-code", usedRatio: 0.3, available: true, windowEndsAt: "2026-10-21T15:00:00.000Z" },
    { executor: "codex", usedRatio: 1, available: false },
  ],
}

// Replaces global fetch for one test; the mock is returned so the request can be inspected.
const stubFetch = (body: unknown, status = 200) => {
  const mock = vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  )
  vi.stubGlobal("fetch", mock)
  return mock
}

// Captures what one command prints: the Console service is swapped for a recorder.
const captured = () => {
  const lines: Array<string> = []
  const testConsole: Console.Console = Object.assign(Object.create(globalThis.console), {
    log: (...args: ReadonlyArray<unknown>) => {
      lines.push(args.map((arg) => String(arg)).join(" "))
    },
  })
  return { lines, console: testConsole }
}

beforeEach(() => {
  vi.stubEnv("APP_URL", SETTINGS.url)
  vi.stubEnv("API_TOKEN", SETTINGS.token)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe("renderQuota", () => {
  it("prints one row per executor with usedRatio, availability and the renewal instant", () => {
    const lines = renderQuota([
      Schema.decodeUnknownSync(QuotaStatus)({ executor: "claude-code", usedRatio: 0.3, available: true }),
      Schema.decodeUnknownSync(QuotaStatus)({
        executor: "codex",
        usedRatio: 1,
        available: false,
        windowEndsAt: "2026-10-21T15:00:00.000Z",
      }),
    ])
    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatch(/^executor\s+usedRatio\s+available\s+windowEndsAt$/)
    expect(lines[1]).toMatch(/^claude-code\s+0\.30\s+yes\s+-$/)
    expect(lines[2]).toMatch(/^codex\s+1\.00\s+no\s+2026-10-21T15:00:00\.000Z$/)
  })
})

describe("exhaustedUntilBody", () => {
  it.effect("sends clear as null", () =>
    Effect.gen(function* () {
      expect(yield* exhaustedUntilBody("clear")).toEqual({ exhaustedUntil: null })
    }),
  )

  it.effect("sends a future ISO instant with a zone as the same instant in UTC", () =>
    Effect.gen(function* () {
      const offsetForm = FUTURE.replace("Z", "+00:00")
      expect(yield* exhaustedUntilBody(offsetForm)).toEqual({ exhaustedUntil: FUTURE })
      expect(yield* exhaustedUntilBody(FUTURE)).toEqual({ exhaustedUntil: FUTURE })
    }),
  )

  it.effect("refuses an instant with no zone, as a usage error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(exhaustedUntilBody("2099-01-01T15:00:00"))
      expect(error).toBeInstanceOf(UsageError)
    }),
  )

  it.effect("refuses an instant that is not in the future, instead of clearing silently", () =>
    Effect.gen(function* () {
      const now = Date.parse("2026-10-21T16:00:00Z")
      const error = yield* Effect.flip(exhaustedUntilBody("2026-10-21T15:00:00Z", now))
      expect(error).toBeInstanceOf(UsageError)
      expect(error.message).toMatch(/clear, or an ISO instant with its zone in the future/)
    }),
  )

  it.effect("refuses a time that is not an ISO instant, as a usage error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(exhaustedUntilBody("tomorrow"))
      expect(error).toBeInstanceOf(UsageError)
    }),
  )
})

describe("quota requests", () => {
  it.effect("GET /executors/quota decodes the list of statuses", () =>
    Effect.gen(function* () {
      const mock = stubFetch(QUOTAS)
      const quotas = yield* quotaList(SETTINGS)
      expect(quotas.map((quota) => quota.executor)).toEqual(["claude-code", "codex"])
      const [url, init] = mock.mock.calls[0] ?? []
      expect(String(url)).toBe("http://localhost:28900/executors/quota")
      expect(init?.method ?? "GET").toBe("GET")
    }),
  )

  it.effect("POST /executors/:id/quota sends the body and returns the status of that executor", () =>
    Effect.gen(function* () {
      const mock = stubFetch({ executor: "claude-code", usedRatio: 0, available: true })
      const status = yield* quotaSet(SETTINGS, "claude-code", { exhaustedUntil: null })
      expect(status).toMatchObject({ executor: "claude-code", available: true })
      const [url, init] = mock.mock.calls[0] ?? []
      expect(String(url)).toBe("http://localhost:28900/executors/claude-code/quota")
      expect(init?.method).toBe("POST")
      expect(JSON.parse(String(init?.body))).toEqual({ exhaustedUntil: null })
    }),
  )
})

describe("executor quota (happy path, fetch stubbed)", () => {
  it.effect("prints the table of every executor from GET /executors/quota", () =>
    Effect.gen(function* () {
      const out = captured()
      const mock = stubFetch(QUOTAS)
      yield* executorCommand(["quota"]).pipe(Effect.provideService(Console.Console, out.console))
      expect(String(mock.mock.calls[0]?.[0])).toBe("http://localhost:28900/executors/quota")
      const lines = out.lines
      expect(lines[0]).toMatch(/^executor\s+usedRatio\s+available\s+windowEndsAt$/)
      expect(lines).toContainEqual(
        expect.stringMatching(/^claude-code\s+0\.30\s+yes\s+2026-10-21T15:00:00\.000Z$/),
      )
      expect(lines).toContainEqual(expect.stringMatching(/^codex\s+1\.00\s+no\s+-$/))
    }),
  )

  it.effect("set posts the future instant and prints the resulting status as JSON", () =>
    Effect.gen(function* () {
      const out = captured()
      const mock = stubFetch({
        executor: "claude-code",
        usedRatio: 0.3,
        available: false,
        windowEndsAt: FUTURE,
      })
      yield* executorCommand(["quota", "set", "claude-code", "--exhausted-until", FUTURE]).pipe(
        Effect.provideService(Console.Console, out.console),
      )
      const [url, init] = mock.mock.calls[0] ?? []
      expect(String(url)).toBe("http://localhost:28900/executors/claude-code/quota")
      expect(init?.method).toBe("POST")
      expect(JSON.parse(String(init?.body))).toEqual({ exhaustedUntil: FUTURE })
      const output = out.lines.join("\n")
      expect(JSON.parse(output)).toMatchObject({
        executor: "claude-code",
        available: false,
        windowEndsAt: FUTURE,
      })
    }),
  )

  it.effect("set with clear posts null", () =>
    Effect.gen(function* () {
      const out = captured()
      const mock = stubFetch({ executor: "claude-code", usedRatio: 0.3, available: true })
      yield* executorCommand(["quota", "set", "claude-code", "--exhausted-until", "clear"]).pipe(
        Effect.provideService(Console.Console, out.console),
      )
      expect(JSON.parse(String(mock.mock.calls[0]?.[1]?.body))).toEqual({ exhaustedUntil: null })
    }),
  )
})

describe("executorCommand usage", () => {
  it.effect("refuses an unknown executor subcommand", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(executorCommand(["list"]))
      expect(error).toBeInstanceOf(UsageError)
      expect(error.message).toBe("unknown executor subcommand: list")
    }),
  )

  it.effect("refuses set without an id or without --exhausted-until", () =>
    Effect.gen(function* () {
      const noId = yield* Effect.flip(executorCommand(["quota", "set", "--exhausted-until", "clear"]))
      expect(noId).toBeInstanceOf(UsageError)
      const noUntil = yield* Effect.flip(executorCommand(["quota", "set", "claude-code"]))
      expect(noUntil).toBeInstanceOf(UsageError)
      expect(noUntil.message).toBe("usage: executor quota set <executor id> --exhausted-until <iso|clear>")
    }),
  )

  it.effect("refuses extra positional arguments on the list", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(executorCommand(["quota", "claude-code"]))
      expect(error.message).toBe("usage: executor quota")
    }),
  )
})
