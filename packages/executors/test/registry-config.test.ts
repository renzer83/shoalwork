import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { it } from "@effect/vitest"
import { BotId, ConfigError, ExecutorSpawnError, type ExecutorTask, TaskId } from "@shoalwork/contracts"
import { type RunningProcess, Tank, type TankContext, type TankShape } from "@shoalwork/tank"
import { Effect, Schema, Stream } from "effect"
import { afterAll, describe, expect } from "vitest"
import type { Executor } from "../src/executor.js"
import { ExecutorSpec, type ExecutorsConfigDeps, loadExecutorsConfig } from "../src/registry-config.js"
import { TierConfig } from "../src/tiers.js"

const REPO_CONFIG = fileURLToPath(new URL("../../../config/executors.yaml", import.meta.url))

const TIERS = Schema.decodeUnknownSync(TierConfig)({
  model_tiers: {
    chat: { executor: "claude-code@chat", model: "claude-haiku-5-5", effort: "low" },
    decision: { executor: "claude-code@chat", model: "claude-haiku-5-5", effort: "low" },
    light: { executor: "claude-code", model: "claude-haiku-5-5", effort: "high" },
    heavy: { executor: "claude-code", model: "claude-opus-5-5", effort: "high", alternatives: ["codex"] },
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

const dirs: Array<string> = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const yamlFile = (text: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "executors-config-"))
  dirs.push(dir)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, "executors.yaml")
  writeFileSync(path, text)
  return path
}

// Test deps: empty core env, every binary present, no quota store, a policy that is never asked.
const depsWith = (overrides: Partial<ExecutorsConfigDeps> = {}): ExecutorsConfigDeps => ({
  env: {},
  onPath: () => true,
  tiers: TIERS,
  quota: undefined,
  permissionBridge: false,
  codexModels: undefined,
  codexCounter: { windowSeconds: 18_000, softLimitTokens: 1_000_000 },
  policy: () => Effect.die("policy not used by the registry test"),
  ...overrides,
})

const byId = (executors: ReadonlyArray<Executor>, id: string): Executor => {
  const found = executors.find((executor) => executor.id === id)
  if (found === undefined) throw new Error(`no executor ${id} in the test fixture`)
  return found
}

const BOT = Schema.decodeUnknownSync(BotId)("bot_00000000-0000-4000-8000-000000000001")
const TASK: ExecutorTask = {
  taskId: Schema.decodeUnknownSync(TaskId)("task_00000000-0000-4000-8000-000000000002"),
  botId: BOT,
  prompt: "say hello",
  tier: "light",
  allowedTools: [],
  permissionMode: "readonly",
  maxTurns: 3,
  budget: { tokens: 10_000, seconds: 60, usd: 1 },
}

const ctxWith = (env: Record<string, string>, home: string): TankContext => ({
  botId: BOT,
  botName: "bot-a",
  cwd: home,
  home,
  env,
})

// A process with no output: the run ends without a result, which is enough to observe the spawn.
const silentProcess = (): RunningProcess => ({
  pid: 4244,
  stdout: Stream.empty,
  stderr: Stream.empty,
  exitCode: Effect.succeed(0),
  writeStdin: () => Effect.void,
  closeStdin: () => Effect.void,
  kill: () => Effect.void,
})

// Records the env and argv of every spawn; the tank serves a silent process.
const recordingTank = () => {
  const spawns: Array<{
    readonly env: Readonly<Record<string, string>>
    readonly cmd: ReadonlyArray<string>
  }> = []
  const unused = () => Effect.die("tank not used by this test")
  const shape: TankShape = {
    mode: "local",
    prepare: unused,
    exec: unused,
    spawnStream: (spawnCtx, cmd) =>
      Effect.sync(() => {
        spawns.push({ env: spawnCtx.env, cmd })
        return silentProcess()
      }),
    readFile: unused,
    writeFile: unused,
    writeHomeFile: unused,
    worktrees: unused,
    removeWorktree: unused,
    release: unused,
  }
  return { shape, spawns }
}

const runWith = (executor: Executor, ctx: TankContext, shape: TankShape) =>
  Stream.runCollect(executor.run(TASK, ctx)).pipe(Effect.scoped, Effect.provideService(Tank, shape))

describe("executors.yaml registry", () => {
  it.effect("builds the seven instances of config/executors.yaml with their ids, in file order", () =>
    Effect.gen(function* () {
      const executors = yield* loadExecutorsConfig(REPO_CONFIG, depsWith())
      expect(executors.map((executor) => executor.id)).toEqual([
        "claude-code",
        "claude-code@zai",
        "claude-code@ollama",
        "codex",
        "codex@ollama",
        "ollama",
        "forja",
      ])
    }),
  )

  it.effect("a missing ZAI_API_KEY leaves claude-code@zai listed as unavailable, not a boot error", () =>
    Effect.gen(function* () {
      const executors = yield* loadExecutorsConfig(REPO_CONFIG, depsWith({ env: {} }))
      const zai = byId(executors, "claude-code@zai")
      const status = yield* zai.quota()
      expect(status.available).toBe(false)
      const { shape, spawns } = recordingTank()
      const failure = yield* Effect.flip(
        runWith(zai, ctxWith({ HOME: "/tank/bot-a/home" }, "/tank/bot-a/home"), shape),
      )
      expect(failure).toBeInstanceOf(ExecutorSpawnError)
      expect(String(failure.cause)).toContain("ZAI_API_KEY")
      expect(spawns).toEqual([])
    }),
  )

  it.effect("the Z.ai token reaches only the claude-code@zai run, and no API key variable is passed", () =>
    Effect.gen(function* () {
      // The secret is assembled at runtime so no literal key sits in the source.
      const secret = ["zai", "test", "value"].join("-")
      const home = mkdtempSync(join(tmpdir(), "executors-zai-"))
      dirs.push(home)
      const executors = yield* loadExecutorsConfig(REPO_CONFIG, depsWith({ env: { ZAI_API_KEY: secret } }))
      const zai = byId(executors, "claude-code@zai")
      expect((yield* zai.quota()).available).toBe(true)
      const { shape, spawns } = recordingTank()
      yield* runWith(zai, ctxWith({ HOME: home, ANTHROPIC_API_KEY: "must-not-pass" }, home), shape)
      expect(spawns).toHaveLength(1)
      const env = spawns[0]?.env ?? {}
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe(secret)
      expect(env.ANTHROPIC_BASE_URL).toBe("https://api.z.ai/api/anthropic")
      expect(env).not.toHaveProperty("ANTHROPIC_API_KEY")
      // The plain claude-code instance does not see the Z.ai token.
      const plain = byId(executors, "claude-code")
      const other = recordingTank()
      yield* runWith(plain, ctxWith({ HOME: home }, home), other.shape)
      expect(other.spawns[0]?.env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN")
    }),
  )

  it.effect("claude-code@ollama is always available and points at the local endpoint", () =>
    Effect.gen(function* () {
      const executors = yield* loadExecutorsConfig(REPO_CONFIG, depsWith({ env: {} }))
      const ollama = byId(executors, "claude-code@ollama")
      expect((yield* ollama.quota()).available).toBe(true)
    }),
  )

  it.effect("codex and codex@ollama are not listed when codex is not on PATH", () =>
    Effect.gen(function* () {
      const executors = yield* loadExecutorsConfig(
        REPO_CONFIG,
        depsWith({ onPath: (bin) => bin !== "codex" }),
      )
      const ids = executors.map((executor) => executor.id)
      expect(ids).not.toContain("codex")
      expect(ids).not.toContain("codex@ollama")
      expect(ids).toContain("forja")
    }),
  )

  it.effect("the ollama openai-compat instance is available without any key", () =>
    Effect.gen(function* () {
      const executors = yield* loadExecutorsConfig(REPO_CONFIG, depsWith({ env: {} }))
      expect((yield* byId(executors, "ollama").quota()).available).toBe(true)
    }),
  )

  it.effect("forja is unavailable when its binary is absent", () =>
    Effect.gen(function* () {
      const executors = yield* loadExecutorsConfig(REPO_CONFIG, depsWith({ onPath: () => false }))
      expect((yield* byId(executors, "forja").quota()).available).toBe(false)
    }),
  )

  it.effect("codex@ollama writes its provider table into CODEX_HOME before the run", () =>
    Effect.gen(function* () {
      const home = mkdtempSync(join(tmpdir(), "executors-codex-"))
      dirs.push(home)
      const executors = yield* loadExecutorsConfig(REPO_CONFIG, depsWith())
      const { shape } = recordingTank()
      const codexHome = join(home, ".codex")
      yield* runWith(
        byId(executors, "codex@ollama"),
        ctxWith({ HOME: home, CODEX_HOME: codexHome }, home),
        shape,
      )
      const text = readFileSync(join(codexHome, "config.toml"), "utf8")
      expect(text).toContain('model_provider = "local_ollama"')
      expect(text).toContain("[model_providers.local_ollama]")
      expect(text).toContain('base_url = "http://localhost:11434/v1"')
    }),
  )

  it.effect("a reference to an env var outside the allowlist is a ConfigError naming it", () =>
    Effect.gen(function* () {
      const path = referenceFixture("DATABASE_URL")
      const error = yield* Effect.flip(loadExecutorsConfig(path, depsWith()))
      expect(error).toBeInstanceOf(ConfigError)
      expect(error.message).toContain("DATABASE_URL")
    }),
  )

  it.effect("two entries with the same id are a ConfigError", () =>
    Effect.gen(function* () {
      const path = yamlFile(
        "executors:\n  - { id: forja, kind: forja, bin: forja }\n  - { id: forja, kind: forja, bin: forja2 }\n",
      )
      const error = yield* Effect.flip(loadExecutorsConfig(path, depsWith()))
      expect(error.message).toContain("duplicate executor id: forja")
    }),
  )

  it.effect("a missing file is a ConfigError naming the path", () =>
    Effect.gen(function* () {
      const path = join(tmpdir(), "does-not-exist-executors.yaml")
      const error = yield* Effect.flip(loadExecutorsConfig(path, depsWith()))
      expect(error).toBeInstanceOf(ConfigError)
      expect(error.key).toBe(path)
    }),
  )

  it.effect("an unknown kind is a ConfigError, not a silent skip", () =>
    Effect.gen(function* () {
      const path = yamlFile("executors:\n  - { id: weird, kind: teleport }\n")
      const error = yield* Effect.flip(loadExecutorsConfig(path, depsWith()))
      expect(error).toBeInstanceOf(ConfigError)
    }),
  )
})

describe("executor spec schema", () => {
  it("round-trips a codex instance with a provider", () => {
    const input = {
      id: "codex@ollama",
      kind: "codex",
      model: "qwen3:8b",
      codexProvider: { name: "local_ollama", base_url: "http://localhost:11434/v1", wire_api: "responses" },
    }
    const decoded = Schema.decodeUnknownSync(ExecutorSpec)(input)
    expect(Schema.encodeUnknownSync(ExecutorSpec)(decoded)).toEqual(input)
  })

  it("rejects an entry whose id is outside the ExecutorId pattern", () => {
    expect(() =>
      Schema.decodeUnknownSync(ExecutorSpec)({ id: "Bad Id", kind: "forja", bin: "forja" }),
    ).toThrow()
  })
})

function referenceFixture(name: string): string {
  return yamlFile(
    `executors:\n  - id: claude-code@x\n    kind: claude-code\n    env:\n      TOKEN: "\${${name}}"\n`,
  )
}
