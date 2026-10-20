import { it } from "@effect/vitest"
import { BotRegistry } from "@shoalwork/bots"
import { type ExecutorEvent, ExecutorId, type RepoRef, SchemaViolation, TaskId } from "@shoalwork/contracts"
import { type Executor, type ExecutorContext, TierConfig } from "@shoalwork/executors"
import { Effect, Fiber, Redacted, Schema, Stream } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { Control, GLOBAL, Lead, McpTokenRejected, McpTokens } from "../src/index.js"
import {
  allEvents,
  createBot,
  eventsOf,
  eventTypes,
  fakeExecutor,
  leadLayer,
  makeFakeTank,
  NEW_BOT,
  OK_EVENTS,
  specFor,
} from "./support.js"

const SERVER = { serverEntry: "/opt/shoalwork/packages/reef/dist/mcp.js", api: "http://127.0.0.1:28900" }
const REPO: RepoRef = { url: "https://user:pass@GitHub.com/renzer83/Shoalwork.git", base: "main" }
const REPO_KEY = "github.com/renzer83/Shoalwork"
const ENV_KEY = "SHOALWORK_API_TOKEN"
const GEMINI = Schema.decodeUnknownSync(ExecutorId)("gemini")
const TASK = Schema.decodeUnknownSync(TaskId)("task_00000000-0000-4000-8000-000000000001")
const FAILING_PROTOCOL: ReadonlyArray<ExecutorEvent> = [
  { kind: "error", code: "protocol", message: "pipe closed" },
]

// Same tiers, served by an executor that cannot take the reef server.
const OTHER_TIERS = Schema.decodeUnknownSync(TierConfig)({
  model_tiers: {
    chat: { executor: "gemini", model: "gemini-model", effort: "low" },
    decision: { executor: "gemini", model: "gemini-model", effort: "low" },
    light: { executor: "gemini", model: "gemini-model", effort: "high" },
    heavy: { executor: "gemini", model: "gemini-model", effort: "high" },
  },
  routing: {
    code: "heavy",
    research: "heavy",
    plan: "heavy",
    review: "heavy",
    chat: "chat",
    status: "chat",
    system: "chat",
    app_op: "light",
    routine: "light",
  },
})

const TokenRows = Schema.Array(Schema.Struct({ revoked_at: Schema.NullOr(Schema.String) }))

// The tank records the env each execution asked for (extraEnv) before the fake tank answers as usual.
const recordingTank = (opts: Parameters<typeof makeFakeTank>[0] = {}) => {
  const fake = makeFakeTank(opts)
  const extraEnvs: Array<Readonly<Record<string, string>> | undefined> = []
  const shape = {
    ...fake.shape,
    prepare: (
      bot: Parameters<typeof fake.shape.prepare>[0],
      step: Parameters<typeof fake.shape.prepare>[1],
    ) => {
      extraEnvs.push(step.extraEnv)
      return fake.shape.prepare(bot, step)
    },
  }
  return { tank: { ...fake, shape }, extraEnvs }
}

// Executor that records the context of every run; `stream` is asked for each run's events.
const recordingExecutor = (
  stream: () => ReturnType<Executor["run"]>,
  contexts: Array<ExecutorContext>,
  id?: ExecutorId,
): Executor => {
  const base = fakeExecutor(() => eventsOf(OK_EVENTS)())
  return {
    ...base,
    ...(id === undefined ? {} : { id }),
    run: (_task, ctx) => {
      contexts.push(ctx)
      return stream()
    },
  }
}

const tokenValues = (extraEnvs: ReadonlyArray<Readonly<Record<string, string>> | undefined>): Array<string> =>
  extraEnvs.flatMap((env) => (env?.[ENV_KEY] === undefined ? [] : [env[ENV_KEY]]))

const onlyToken = (extraEnvs: ReadonlyArray<Readonly<Record<string, string>> | undefined>): string => {
  const [value] = tokenValues(extraEnvs)
  if (value === undefined) throw new Error("no token was handed to the tank")
  return value
}

const indexRepo = (repo: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    yield* sql`INSERT INTO code_chunks (id, repo, path, start_line, end_line, sha256, lang, symbols, content, indexed_at)
      VALUES ('chunk-1', ${repo}, 'src/a.ts', 1, 3, 'hash', 'ts', '[]', 'export const a = 1', '2026-10-20T00:00:00.000Z')`
  })

const tokenRows = (taskId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const rows = yield* sql`SELECT revoked_at FROM mcp_tokens WHERE task_id = ${taskId}`
    return yield* Schema.decodeUnknownEffect(TokenRows)(rows)
  })

// A token that is revoked answers McpTokenRejected with reason "revoked" when presented again.
const isRevoked = (token: string) =>
  Effect.gen(function* () {
    const tokens = yield* McpTokens
    const failure = yield* Effect.flip(tokens.verify(token))
    return failure instanceof McpTokenRejected && failure.reason === "revoked"
  })

// Waits (bounded) until the executor has recorded `count` runs.
const untilRuns = (contexts: ReadonlyArray<unknown>, count: number) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 500 && contexts.length < count; attempt += 1) {
      yield* Effect.sleep("10 millis")
    }
  })

const eventsText = Effect.map(allEvents, (events) => JSON.stringify(events))

describe("Lead.runOnce with the reef MCP server", () => {
  it.effect(
    "a run on an indexed repo gets its own token and a reef attachment, revoked when the run ends",
    () => {
      const recorded = recordingTank()
      const contexts: Array<ExecutorContext> = []
      return Effect.gen(function* () {
        yield* indexRepo(REPO_KEY)
        const lead = yield* Lead
        const bot = yield* createBot
        const spec = yield* lead.intake(specFor(bot, { repo: REPO }))
        const verdict = yield* lead.runOnce(spec.id)
        const token = onlyToken(recorded.extraEnvs)

        expect(verdict).toMatchObject({ kind: "ok" })

        expect(Object.keys(recorded.extraEnvs[0] ?? {})).toEqual([ENV_KEY])
        expect(contexts[0]?.mcp).toEqual({
          serverEntry: SERVER.serverEntry,
          repo: REPO_KEY,
          bot: bot.id,
          api: SERVER.api,
        })
        expect(yield* isRevoked(token)).toBe(true)
        expect((yield* tokenRows(spec.id)).map((row) => row.revoked_at !== null)).toEqual([true])
        expect(yield* eventsText).not.toContain(token)
      }).pipe(
        Effect.provide(
          leadLayer({
            executor: recordingExecutor(eventsOf(OK_EVENTS), contexts),
            tank: recorded.tank,
            config: { mcp: SERVER },
          }),
        ),
      )
    },
  )

  it.effect("a run with no repo, no indexed chunks or no configured server gets no MCP and no token", () => {
    const recorded = recordingTank()
    const contexts: Array<ExecutorContext> = []
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const unindexed = yield* lead.intake(specFor(bot, { repo: REPO }))
      yield* lead.runOnce(unindexed.id)
      const noRepo = yield* lead.intake(specFor(bot))
      yield* lead.runOnce(noRepo.id)

      expect(recorded.extraEnvs).toEqual([undefined, undefined])
      expect(contexts.map((ctx) => ctx.mcp)).toEqual([undefined, undefined])
      expect(yield* tokenRows(unindexed.id)).toEqual([])
      // The briefing is still assembled and its event is recorded.
      expect(yield* eventTypes).toContain("context.assembled")
    }).pipe(
      Effect.provide(
        leadLayer({
          executor: recordingExecutor(eventsOf(OK_EVENTS), contexts),
          tank: recorded.tank,
          config: {},
        }),
      ),
    )
  })

  it.effect("with a server configured but no indexed chunks the run gets no token", () => {
    const recorded = recordingTank()
    const contexts: Array<ExecutorContext> = []
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot, { repo: REPO }))
      yield* lead.runOnce(spec.id)

      expect(recorded.extraEnvs).toEqual([undefined])
      expect(contexts[0]?.mcp).toBeUndefined()
      expect(yield* tokenRows(spec.id)).toEqual([])
    }).pipe(
      Effect.provide(
        leadLayer({
          executor: recordingExecutor(eventsOf(OK_EVENTS), contexts),
          tank: recorded.tank,
          config: { mcp: SERVER },
        }),
      ),
    )
  })

  it.effect("an executor that cannot take the reef server gets no token even on an indexed repo", () => {
    const recorded = recordingTank()
    const contexts: Array<ExecutorContext> = []
    return Effect.gen(function* () {
      yield* indexRepo(REPO_KEY)
      const lead = yield* Lead
      // A Bot allowed to use only the gemini executor, so the run reaches the executor.
      const registry = yield* BotRegistry
      const bot = yield* registry.upsert(
        { ...NEW_BOT, executors: { preferred: GEMINI, allowed: [GEMINI] } },
        "test",
      )
      const spec = yield* lead.intake(specFor(bot, { repo: REPO }))
      const verdict = yield* lead.runOnce(spec.id)

      expect(verdict.kind).toBe("ok")
      expect(recorded.extraEnvs).toEqual([undefined])
      expect(contexts[0]?.mcp).toBeUndefined()
      expect(yield* tokenRows(spec.id)).toEqual([])
    }).pipe(
      Effect.provide(
        leadLayer({
          executor: recordingExecutor(eventsOf(OK_EVENTS), contexts, GEMINI),
          tank: recorded.tank,
          tiers: OTHER_TIERS,
          config: { mcp: SERVER },
        }),
      ),
    )
  })

  it.effect("a repo key outside the MCP name allowlist gets no token and is reported", () => {
    const recorded = recordingTank()
    const contexts: Array<ExecutorContext> = []
    return Effect.gen(function* () {
      // The space is kept percent-encoded in the key, and "%" is outside the allowlist.
      const odd: RepoRef = { url: "https://GitHub.com/renzer83/Shoalwork with space.git", base: "main" }
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot, { repo: odd }))
      const verdict = yield* lead.runOnce(spec.id)

      expect(verdict.kind).toBe("ok")
      expect(recorded.extraEnvs).toEqual([undefined])
      expect(contexts[0]?.mcp).toBeUndefined()
      expect(JSON.stringify(yield* allEvents)).toContain("McpScopeRefused")
      expect(yield* tokenRows(spec.id)).toEqual([])
    }).pipe(
      Effect.provide(
        leadLayer({
          executor: recordingExecutor(eventsOf(OK_EVENTS), contexts),
          tank: recorded.tank,
          config: { mcp: SERVER },
        }),
      ),
    )
  })

  it.effect("a token that cannot be issued is reported and the run goes on without MCP", () => {
    const recorded = recordingTank()
    const contexts: Array<ExecutorContext> = []
    return Effect.gen(function* () {
      yield* indexRepo(REPO_KEY)
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot, { repo: REPO }))
      const verdict = yield* lead.runOnce(spec.id)

      expect(verdict.kind).toBe("ok")
      expect(recorded.extraEnvs).toEqual([undefined])
      expect(contexts[0]?.mcp).toBeUndefined()
      expect(JSON.stringify(yield* allEvents)).toContain("lead.mcp")
      expect(yield* eventsText).not.toContain("mcp_")
    }).pipe(
      Effect.provide(
        leadLayer({
          executor: recordingExecutor(eventsOf(OK_EVENTS), contexts),
          tank: recorded.tank,
          config: { mcp: SERVER },
          wrapTokens: (real) => ({
            ...real,
            issue: () => Effect.fail(new SchemaViolation({ where: "mcp.issue", issue: "forced" })),
          }),
        }),
      ),
    )
  })

  it.effect("a failed index lookup is reported and the run goes on without MCP", () => {
    const recorded = recordingTank()
    const contexts: Array<ExecutorContext> = []
    return Effect.gen(function* () {
      // The lookup reads code_chunks: without the table it fails, and the run must not.
      const sql = yield* SqlClient
      yield* sql`DROP TABLE code_chunks`
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot, { repo: REPO }))
      const verdict = yield* lead.runOnce(spec.id)

      expect(verdict.kind).toBe("ok")
      expect(recorded.extraEnvs).toEqual([undefined])
      expect(contexts[0]?.mcp).toBeUndefined()
      expect(JSON.stringify(yield* allEvents)).toContain("lead.mcp")
      expect(yield* eventsText).not.toContain("mcp_")
    }).pipe(
      Effect.provide(
        leadLayer({
          executor: recordingExecutor(eventsOf(OK_EVENTS), contexts),
          tank: recorded.tank,
          config: { mcp: SERVER },
        }),
      ),
    )
  })

  it.effect("the token is revoked when the executor fails", () => {
    const recorded = recordingTank()
    const contexts: Array<ExecutorContext> = []
    const failing: ReadonlyArray<ExecutorEvent> = [
      { kind: "error", code: "max_turns", message: "too many turns" },
    ]
    return Effect.gen(function* () {
      yield* indexRepo(REPO_KEY)
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot, { repo: REPO }))
      const verdict = yield* lead.runOnce(spec.id)
      const token = onlyToken(recorded.extraEnvs)

      expect(verdict.kind).toBe("failed")
      expect(yield* isRevoked(token)).toBe(true)
      expect(yield* eventsText).not.toContain(token)
    }).pipe(
      Effect.provide(
        leadLayer({
          executor: recordingExecutor(eventsOf(failing), contexts),
          tank: recorded.tank,
          config: { mcp: SERVER },
        }),
      ),
    )
  })

  it.effect("the token is revoked when the tank cannot prepare the run", () => {
    const recorded = recordingTank({ failPrepare: true })
    const contexts: Array<ExecutorContext> = []
    return Effect.gen(function* () {
      yield* indexRepo(REPO_KEY)
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot, { repo: REPO }))
      const verdict = yield* lead.runOnce(spec.id)
      const token = onlyToken(recorded.extraEnvs)

      expect(verdict.kind).toBe("blocked")
      expect(yield* isRevoked(token)).toBe(true)
      expect(yield* eventsText).not.toContain(token)
    }).pipe(
      Effect.provide(
        leadLayer({
          executor: recordingExecutor(eventsOf(OK_EVENTS), contexts),
          tank: recorded.tank,
          config: { mcp: SERVER },
        }),
      ),
    )
  })

  it.effect("the token is revoked when the executor defects", () => {
    const recorded = recordingTank()
    const contexts: Array<ExecutorContext> = []
    return Effect.gen(function* () {
      yield* indexRepo(REPO_KEY)
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot, { repo: REPO }))
      const verdict = yield* lead.runOnce(spec.id)
      const token = onlyToken(recorded.extraEnvs)

      expect(verdict.kind).toBe("blocked")
      expect(yield* isRevoked(token)).toBe(true)
    }).pipe(
      Effect.provide(
        leadLayer({
          executor: recordingExecutor(() => Stream.fromEffect(Effect.die("boom")), contexts),
          tank: recorded.tank,
          config: { mcp: SERVER },
        }),
      ),
    )
  })

  it.live(
    "the token is revoked when the time budget runs out",
    () => {
      const recorded = recordingTank()
      const contexts: Array<ExecutorContext> = []
      return Effect.gen(function* () {
        yield* indexRepo(REPO_KEY)
        const lead = yield* Lead
        const bot = yield* createBot
        const spec = yield* lead.intake(
          specFor(bot, { repo: REPO, budget: { tokens: 100000, seconds: 1, usd: 1 } }),
        )
        const verdict = yield* lead.runOnce(spec.id)
        const token = onlyToken(recorded.extraEnvs)

        expect(verdict.kind).not.toBe("ok")
        expect(yield* isRevoked(token)).toBe(true)
      }).pipe(
        Effect.provide(
          leadLayer({
            executor: recordingExecutor(() => Stream.fromEffect(Effect.never), contexts),
            tank: recorded.tank,
            config: { mcp: SERVER },
          }),
        ),
      )
    },
    15_000,
  )

  it.live(
    "the token is revoked when the run is stopped",
    () => {
      const recorded = recordingTank()
      const contexts: Array<ExecutorContext> = []
      return Effect.gen(function* () {
        yield* indexRepo(REPO_KEY)
        const lead = yield* Lead
        const control = yield* Control
        const bot = yield* createBot
        const spec = yield* lead.intake(specFor(bot, { repo: REPO }))
        const fiber = yield* Effect.forkChild(lead.runOnce(spec.id))
        // The run has reached its executor once its context is recorded; the executor then hangs until stopped.
        yield* untilRuns(contexts, 1)
        expect(contexts).toHaveLength(1)
        yield* control.stop(GLOBAL, "user:test")
        const verdict = yield* Fiber.join(fiber)

        expect(verdict.kind).toBe("blocked")
        expect(yield* isRevoked(onlyToken(recorded.extraEnvs))).toBe(true)
      }).pipe(
        Effect.provide(
          leadLayer({
            executor: recordingExecutor(() => Stream.fromEffect(Effect.never), contexts),
            tank: recorded.tank,
            config: { mcp: SERVER, stopWaitMs: 2000 },
          }),
        ),
      )
    },
    20_000,
  )

  it.effect("a retry gets a new token of its own, and each token is revoked when its round ends", () => {
    const recorded = recordingTank()
    const contexts: Array<ExecutorContext> = []
    let calls = 0
    return Effect.gen(function* () {
      yield* indexRepo(REPO_KEY)
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot, { repo: REPO }))
      const verdict = yield* lead.runOnce(spec.id)
      const [first, second] = tokenValues(recorded.extraEnvs)

      expect(verdict.kind).toBe("ok")
      expect(recorded.extraEnvs).toHaveLength(2)
      expect(first).toBeDefined()
      expect(second).toBeDefined()
      expect(first).not.toBe(second)
      expect(yield* isRevoked(first ?? "")).toBe(true)
      expect(yield* isRevoked(second ?? "")).toBe(true)
    }).pipe(
      Effect.provide(
        leadLayer({
          executor: recordingExecutor(() => {
            calls += 1
            return eventsOf(calls === 1 ? FAILING_PROTOCOL : OK_EVENTS)()
          }, contexts),
          tank: recorded.tank,
          config: { mcp: SERVER },
        }),
      ),
    )
  })

  it.effect("the boot revokes the tokens of tasks that are not running", () => {
    const recorded = recordingTank()
    const contexts: Array<ExecutorContext> = []
    return Effect.gen(function* () {
      const tokens = yield* McpTokens
      const bot = yield* createBot
      // TASK is not in the tasks table, so it is not running: its token is a leftover of an interrupted run.
      const issued = yield* tokens.issue({ botId: bot.id, repo: REPO_KEY, taskId: TASK, ttl: 60_000 })
      yield* tokens.revokeStale()

      expect(yield* isRevoked(Redacted.value(issued.token))).toBe(true)
    }).pipe(
      Effect.provide(
        leadLayer({
          executor: recordingExecutor(eventsOf(OK_EVENTS), contexts),
          tank: recorded.tank,
          config: {},
        }),
      ),
    )
  })
})
