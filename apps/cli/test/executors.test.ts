import { it } from "@effect/vitest"
import { Console, Effect, Schema } from "effect"
import { afterEach, beforeEach, describe, expect, vi } from "vitest"
import { UsageError } from "../src/args.js"
import {
  DoctorBody,
  doctorHasIssues,
  doctorReports,
  executorsCommand,
  recordPlan,
  renderDoctor,
} from "../src/commands/executors.js"

const SETTINGS = { url: "http://localhost:28900", token: "dev-token" }

// Decoded with the same schema the command uses, so the fixtures are the shape the core sends.
const decodeDoctor = Schema.decodeUnknownSync(DoctorBody)

const REPORTS = decodeDoctor({
  reports: [
    { executor: "claude-code", bin: "claude", installed: "2.1.304", pinned: "2.1.304", status: "ok" },
    {
      executor: "codex",
      bin: "codex",
      installed: "0.163.0",
      pinned: "0.155.1",
      status: "drift",
      detail: "installed 0.163.0, pinned 0.155.1",
    },
    {
      executor: "gemini",
      bin: "gemini",
      installed: null,
      pinned: "0.59.0",
      status: "missing",
      detail: "cannot run gemini",
    },
    {
      executor: "opencode",
      bin: "opencode",
      installed: "1.19.3",
      pinned: "1.19.3",
      status: "auth_missing",
      detail: "no opencode/auth.json",
    },
  ],
})

const ALL_OK = decodeDoctor({
  reports: [
    { executor: "claude-code", bin: "claude", installed: "2.1.304", pinned: "2.1.304", status: "ok" },
  ],
})

const QUOTAS = {
  quotas: [
    { executor: "claude-code", usedRatio: 0.3, available: true, windowEndsAt: "2026-10-21T15:00:00.000Z" },
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
  process.exitCode = undefined
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  process.exitCode = undefined
})

describe("renderDoctor", () => {
  it("prints executor, installed, pinned, status and detail, with - for a missing value", () => {
    const lines = renderDoctor(REPORTS.reports)
    expect(lines).toHaveLength(5)
    expect(lines[0]).toMatch(/^executor\s+installed\s+pinned\s+status\s+detail$/)
    expect(lines[1]).toMatch(/^claude-code\s+2\.1\.304\s+2\.1\.304\s+ok\s+-$/)
    expect(lines[3]).toMatch(/^gemini\s+-\s+0\.59\.0\s+missing\s+cannot run gemini$/)
  })
})

describe("doctorHasIssues", () => {
  it("is false only when every CLI is ok", () => {
    expect(doctorHasIssues(ALL_OK.reports)).toBe(false)
    expect(doctorHasIssues(REPORTS.reports)).toBe(true)
  })
})

describe("recordPlan", () => {
  it("names the fixture folder, the three prompts and the bin, and runs nothing", () => {
    const plan = recordPlan("codex", "0.155.1")
    expect(plan).toMatchObject({
      status: "dry-run",
      executor: "codex",
      bin: "codex",
      version: "0.155.1",
      fixtures: "packages/executors/test/fixtures/codex/0.155.1",
    })
    expect(plan.prompts).toEqual(["pong", "run `echo hi`", "create file x.txt"])
  })
})

describe("executors doctor (fetch stubbed)", () => {
  it.effect("GET /executors/doctor prints the table and exits 0 without --strict", () =>
    Effect.gen(function* () {
      const out = captured()
      const mock = stubFetch(REPORTS)
      yield* executorsCommand(["doctor"]).pipe(Effect.provideService(Console.Console, out.console))
      expect(String(mock.mock.calls[0]?.[0])).toBe("http://localhost:28900/executors/doctor")
      expect(out.lines[0]).toMatch(/^executor\s+installed/)
      expect(process.exitCode).toBeUndefined()
    }),
  )

  it.effect("--strict exits 1 when a CLI is drifted, missing or not logged in", () =>
    Effect.gen(function* () {
      const out = captured()
      stubFetch(REPORTS)
      yield* executorsCommand(["doctor", "--strict"]).pipe(
        Effect.provideService(Console.Console, out.console),
      )
      expect(process.exitCode).toBe(1)
    }),
  )

  it.effect("--strict keeps exit 0 when every CLI is ok", () =>
    Effect.gen(function* () {
      const out = captured()
      stubFetch(ALL_OK)
      yield* executorsCommand(["doctor", "--strict"]).pipe(
        Effect.provideService(Console.Console, out.console),
      )
      expect(process.exitCode).toBeUndefined()
    }),
  )

  it.effect("decodes the reports of GET /executors/doctor at the boundary", () =>
    Effect.gen(function* () {
      stubFetch(ALL_OK)
      const reports = yield* doctorReports(SETTINGS)
      expect(reports).toEqual(ALL_OK.reports)
    }),
  )
})

describe("executors list (fetch stubbed)", () => {
  it.effect("prints every executor with availability and quota from GET /executors/quota", () =>
    Effect.gen(function* () {
      const out = captured()
      const mock = stubFetch(QUOTAS)
      yield* executorsCommand(["list"]).pipe(Effect.provideService(Console.Console, out.console))
      expect(String(mock.mock.calls[0]?.[0])).toBe("http://localhost:28900/executors/quota")
      expect(out.lines).toContainEqual(
        expect.stringMatching(/^claude-code\s+0\.30\s+yes\s+2026-10-21T15:00:00\.000Z$/),
      )
    }),
  )
})

describe("executors record", () => {
  it.effect("--dry-run prints the plan and makes no request", () =>
    Effect.gen(function* () {
      const out = captured()
      const mock = stubFetch({})
      yield* executorsCommand(["record", "--executor", "gemini", "--version", "0.59.0", "--dry-run"]).pipe(
        Effect.provideService(Console.Console, out.console),
      )
      expect(mock).not.toHaveBeenCalled()
      expect(JSON.parse(out.lines.join("\n"))).toMatchObject({
        status: "dry-run",
        fixtures: "packages/executors/test/fixtures/gemini/0.59.0",
      })
    }),
  )

  it.effect("without --dry-run refuses as NOT_RUN (the live probe is T-166)", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        executorsCommand(["record", "--executor", "codex", "--version", "0.155.1"]),
      )
      expect(error).toBeInstanceOf(UsageError)
      expect(error.message).toMatch(/^NOT_RUN: .*T-166/)
    }),
  )

  it.effect("refuses an executor outside the four CLIs", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        executorsCommand(["record", "--executor", "codex@ollama", "--version", "0.155.1", "--dry-run"]),
      )
      expect(error).toBeInstanceOf(UsageError)
    }),
  )

  it.effect("refuses a version that is not a semver", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        executorsCommand(["record", "--executor", "codex", "--version", "latest", "--dry-run"]),
      )
      expect(error).toBeInstanceOf(UsageError)
    }),
  )
})

describe("executors dispatch", () => {
  it.effect("refuses an unknown subcommand as a usage error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(executorsCommand(["upgrade"]))
      expect(error).toBeInstanceOf(UsageError)
      expect(error.message).toBe("unknown executors subcommand: upgrade")
    }),
  )
})
