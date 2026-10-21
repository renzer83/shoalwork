import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BeaconLive } from "@shoalwork/beacon"
import { BotRegistry, type BotRegistryShape } from "@shoalwork/bots"
import { Bot, type BotState, ExecutorId } from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { type DoctorReport, type Executor, makeRegistry } from "@shoalwork/executors"
import { type ExecResult, Tank, type TankShape } from "@shoalwork/tank"
import { Effect, Layer, ManagedRuntime, Redacted, Ref, Schema, Stream } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import { DoctorGate } from "../src/executors-compose.js"
import { makeApp } from "../src/http/app.js"
import type { RunEffect } from "../src/http/routes/respond.js"

const TOKEN = "test-token"
const AUTH = { authorization: `Bearer ${TOKEN}` }
const ANA = "bot_3f2a9c1e-7b4d-4e8a-9f10-2c6d5e8b7a41"
const BIA = "bot_1b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e"
const OLD = "bot_9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b"

const decodeBot = (id: string, name: string, state: BotState) => ({
  ...Schema.decodeUnknownSync(Bot)({
    id,
    name,
    role: "tester",
    instructions: "Test the executors.",
    kind: "auxiliary",
    executors: { preferred: "claude-code", allowed: ["claude-code"] },
    modelTiers: {},
    connectors: [],
    budget: { tokens: 1000, seconds: 60, usd: 1 },
    policy: "default",
    tank: { mode: "local", host: "mac" },
    memory: { scope: "bot" },
  }),
  state,
})
const BOTS = [
  decodeBot(ANA, "ana", "idle"),
  decodeBot(BIA, "bia", "paused"),
  decodeBot(OLD, "old", "archived"),
]

const EXECUTOR_IDS = ["claude-code", "claude-code@zai", "codex", "acp-gemini", "ollama"] as const
const executorIdOf = (id: string): ExecutorId => Schema.decodeUnknownSync(ExecutorId)(id)
const quotaOf = (id: string, usedRatio: number) => ({
  executor: Schema.decodeUnknownSync(ExecutorId)(id),
  usedRatio,
  available: usedRatio < 1,
})
const executorOf = (id: string, usedRatio: number): Executor => ({
  id: Schema.decodeUnknownSync(ExecutorId)(id),
  run: () => Stream.empty,
  mapTier: () => ({ model: "fixture" }),
  quota: () => Effect.succeed(quotaOf(id, usedRatio)),
})
const EXECUTORS = [
  executorOf("claude-code", 0.85),
  executorOf("claude-code@zai", 0),
  executorOf("codex", 0.1),
  executorOf("acp-gemini", 0),
  executorOf("ollama", 0),
]

// The boot doctor's verdict as the gate holds it: claude ok, codex drifted, gemini missing.
const REPORTS: ReadonlyArray<DoctorReport> = [
  {
    executor: executorIdOf("claude-code"),
    bin: "claude",
    installed: "2.1.304",
    pinned: "2.1.304",
    status: "ok",
  },
  {
    executor: executorIdOf("codex"),
    bin: "codex",
    installed: "0.163.0",
    pinned: "0.155.1",
    status: "drift",
    detail: "installed 0.163.0, pinned 0.155.1",
  },
  {
    executor: executorIdOf("acp-gemini"),
    bin: "gemini",
    installed: null,
    pinned: "0.59.0",
    status: "missing",
  },
]

// A fake Tank: each Bot's CLIs answer from the name of the Bot. Ana is logged in everywhere; Bia only to claude's "none".
const unused = () => Effect.die("not used by the overview")
const result = (exitCode: number, stdout: string): ExecResult => ({
  exitCode,
  stdout,
  stderr: "",
  durationMs: 1,
  timedOut: false,
})
const answer = (botName: string, cmd: ReadonlyArray<string>): ExecResult => {
  const [bin, ...args] = cmd
  const ana = botName === "ana"
  if (bin === "claude") {
    // The extra fields are secret-looking and must never reach the overview.
    return ana
      ? result(0, '{"authMethod":"claude.ai","accessToken":"fixture-value","email":"ana@example.test"}')
      : result(0, '{"authMethod":"none"}')
  }
  if (bin === "codex") return result(ana ? 0 : 1, "")
  if (bin === "ls") return result(ana && (args[1] ?? "").includes(".gemini") ? 0 : 2, "")
  return result(127, "")
}
const fakeTank = (prepared: Array<string>): TankShape => ({
  mode: "local",
  prepare: (bot) =>
    Effect.sync(() => {
      prepared.push(bot.name)
      const home = `/homes/${bot.name}`
      return { botId: bot.id, botName: bot.name, cwd: home, home, env: {} }
    }),
  exec: (ctx, cmd) => Effect.succeed(answer(ctx.botName, cmd)),
  spawnStream: unused,
  readFile: unused,
  writeFile: unused,
  writeHomeFile: unused,
  release: unused,
  worktrees: unused,
  removeWorktree: unused,
})

const fakeBots = (): BotRegistryShape => ({
  syncFromDir: unused,
  upsert: unused,
  update: unused,
  get: unused,
  getByName: unused,
  list: () => Effect.succeed(BOTS),
  setState: unused,
})

const prepared: Array<string> = []
const layerWith = () =>
  Layer.mergeAll(
    makeRegistry(EXECUTORS),
    Layer.effect(DoctorGate, Ref.make(REPORTS)),
    Layer.succeed(BotRegistry, fakeBots()),
    Layer.succeed(Tank, fakeTank(prepared)),
  ).pipe(Layer.provideMerge(Layer.provideMerge(BeaconLive, withTempDb())))
type Built = Layer.Success<ReturnType<typeof layerWith>>
type Runtime = ManagedRuntime.ManagedRuntime<Built, Layer.Error<ReturnType<typeof layerWith>>>

const withRuntime = async <A>(body: (runtime: Runtime) => Promise<A>): Promise<A> => {
  const runtime = ManagedRuntime.make(layerWith())
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient
        yield* sql`INSERT INTO executor_quality (executor, kind, window_days, n, ok_rate, retry_rate, avg_usd, avg_seconds, computed_at)
          VALUES ('claude-code', 'code', 30, 4, 0.75, 0, 0.02, 12, '2026-10-21T10:00:00.000Z'),
                 ('claude-code', 'chat', 7, 9, 0.1, 0, 0.01, 3, '2026-10-21T10:00:00.000Z')`
      }),
    )
    return await body(runtime)
  } finally {
    await runtime.dispose()
  }
}

const appFor = (runtime: Runtime) => {
  const runEffect: RunEffect = <A, E>(eff: Effect.Effect<A, E, Built>) => runtime.runPromise(eff)
  return makeApp({ apiToken: Redacted.make(TOKEN), runEffect })
}

const Overview = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    cli: Schema.NullOr(Schema.String),
    installedVersion: Schema.NullOr(Schema.String),
    pinnedVersion: Schema.NullOr(Schema.String),
    status: Schema.NullOr(Schema.String),
    ok: Schema.NullOr(Schema.Boolean),
    quota: Schema.Struct({ usedRatio: Schema.Number, available: Schema.Boolean }),
    quality: Schema.Array(
      Schema.Struct({ kind: Schema.String, okRate: Schema.Number, n: Schema.Number, avgUsd: Schema.Number }),
    ),
    logins: Schema.Array(
      Schema.Struct({ botId: Schema.String, authMethod: Schema.NullOr(Schema.String), state: Schema.String }),
    ),
  }),
)
type Overview = typeof Overview.Type

const overviewOf = async (
  app: ReturnType<typeof makeApp>,
): Promise<{ readonly raw: string; readonly list: Overview }> => {
  const response = await app.request("/executors", { headers: AUTH })
  expect(response.status).toBe(200)
  const raw = await response.text()
  return { raw, list: Schema.decodeUnknownSync(Overview)(JSON.parse(raw)) }
}

const byId = (list: Overview, id: string) => {
  const found = list.find((entry) => entry.id === id)
  if (found === undefined) throw new Error(`no executor ${id}`)
  return found
}

const hosts: Array<string> = []
afterEach(() => {
  vi.unstubAllEnvs()
  prepared.length = 0
})
afterAll(() => {
  for (const path of hosts) rmSync(path, { recursive: true, force: true })
})

describe("GET /executors", () => {
  it("refuses a request without the API token", async () => {
    await withRuntime(async (runtime) => {
      const response = await appFor(runtime).request("/executors")
      expect(response.status).toBe(401)
    })
  })

  it("aggregates the doctor verdict, the quota, the 30-day quality and each Bot's login per executor", async () => {
    await withRuntime(async (runtime) => {
      const { list } = await overviewOf(appFor(runtime))
      expect(list.map((entry) => entry.id)).toEqual(EXECUTOR_IDS)

      const claude = byId(list, "claude-code")
      expect(claude).toMatchObject({
        cli: "claude",
        installedVersion: "2.1.304",
        pinnedVersion: "2.1.304",
        status: "ok",
        ok: true,
        quota: { usedRatio: 0.85, available: true },
        quality: [{ kind: "code", okRate: 0.75, n: 4, avgUsd: 0.02 }],
      })
      expect(claude.logins).toEqual([
        { botId: ANA, authMethod: "claude.ai", state: "logged_in" },
        { botId: BIA, authMethod: "none", state: "logged_out" },
      ])

      expect(byId(list, "codex")).toMatchObject({
        status: "drift",
        ok: false,
        installedVersion: "0.163.0",
        pinnedVersion: "0.155.1",
        logins: [
          { botId: ANA, authMethod: null, state: "logged_in" },
          { botId: BIA, authMethod: null, state: "logged_out" },
        ],
      })
      expect(byId(list, "acp-gemini")).toMatchObject({
        status: "missing",
        ok: false,
        installedVersion: null,
        logins: [
          { botId: ANA, authMethod: "oauth", state: "logged_in" },
          { botId: BIA, authMethod: null, state: "logged_out" },
        ],
      })
    })
  })

  it("gives a variant on another endpoint its CLI's version, but no login", async () => {
    await withRuntime(async (runtime) => {
      const { list } = await overviewOf(appFor(runtime))
      expect(byId(list, "claude-code@zai")).toMatchObject({
        cli: "claude",
        installedVersion: "2.1.304",
        logins: [],
      })
    })
  })

  it("reports an executor with no CLI as unchecked, with no login and no version", async () => {
    await withRuntime(async (runtime) => {
      const { list } = await overviewOf(appFor(runtime))
      expect(byId(list, "ollama")).toMatchObject({
        cli: null,
        installedVersion: null,
        pinnedVersion: null,
        status: null,
        ok: null,
        logins: [],
      })
    })
  })

  it("asks no archived Bot, and answers no secret the CLIs printed", async () => {
    await withRuntime(async (runtime) => {
      const { raw, list } = await overviewOf(appFor(runtime))
      expect(prepared).not.toContain("old")
      expect(list.flatMap((entry) => entry.logins).some((login) => login.botId === OLD)).toBe(false)
      expect(raw).not.toMatch(/accessToken|fixture-value|example\.test/)
    })
  })
})

describe("POST /executors/:id/doctor", () => {
  it("answers 404 for an unknown executor and 409 for one whose CLI the doctor does not check", async () => {
    await withRuntime(async (runtime) => {
      const app = appFor(runtime)
      expect((await app.request("/executors/nope/doctor", { method: "POST", headers: AUTH })).status).toBe(
        404,
      )
      const ollama = await app.request("/executors/ollama/doctor", { method: "POST", headers: AUTH })
      expect(ollama.status).toBe(409)
    })
  })

  it("re-probes only that CLI and puts the new verdict in the gate", async () => {
    // A host whose codex is at its pin and logged in; no other CLI exists here, so only codex can answer.
    const host = mkdtempSync(join(tmpdir(), "core-overview-test-"))
    hosts.push(host)
    const bin = join(host, "bin")
    mkdirSync(bin, { recursive: true })
    const script = join(bin, "codex")
    writeFileSync(
      script,
      '#!/bin/sh\ncase "$1" in --version) echo "codex-cli 0.155.1" ;; login) exit 0 ;; esac\n',
    )
    chmodSync(script, 0o755)
    vi.stubEnv("PATH", bin)
    const home = join(host, "home")
    mkdirSync(home, { recursive: true })
    vi.stubEnv("HOME", home)

    await withRuntime(async (runtime) => {
      const app = appFor(runtime)
      const response = await app.request("/executors/codex/doctor", { method: "POST", headers: AUTH })
      expect(response.status).toBe(200)
      const body: unknown = await response.json()
      expect(body).toMatchObject({
        report: { executor: "codex", bin: "codex", status: "ok", installed: "0.155.1" },
      })

      const { list } = await overviewOf(app)
      expect(byId(list, "codex")).toMatchObject({ status: "ok", ok: true })
      expect(byId(list, "claude-code")).toMatchObject({ status: "ok", ok: true })
      expect(byId(list, "acp-gemini")).toMatchObject({ status: "missing" })
    })
  })
})
