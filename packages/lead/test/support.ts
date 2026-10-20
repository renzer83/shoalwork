import { Beacon, BeaconLive, BeaconTest } from "@shoalwork/beacon"
import { BotRegistry, BotRegistryLive } from "@shoalwork/bots"
import {
  type Bot,
  type ExecutorEvent,
  ExecutorId,
  type ExecutorTask,
  NewBot,
  SessionId,
  TankError,
  type TaskSpec,
  WorktreeConflict,
} from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { type Executor, ExecutorRegistry, makeRegistry } from "@shoalwork/executors"
import { type ExecResult, Tank, type TankContext, type TankShape } from "@shoalwork/tank"
import { Effect, Layer, Schema, Stream } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { Lead, type LeadConfig, LeadLive, TaskStore } from "../src/index.js"
import { makeTaskStore, type TaskStoreShape } from "../src/tasks.js"

export const CLAUDE = Schema.decodeUnknownSync(ExecutorId)("claude-code")

const NEW_BOT = Schema.decodeUnknownSync(NewBot)({
  name: "worker-bot",
  role: "developer",
  kind: "auxiliary",
  instructions: "Do the work you are given.",
  executors: { preferred: "claude-code", allowed: ["claude-code"] },
  modelTiers: {},
  connectors: [],
  budget: { tokens: 500000, seconds: 1800, usd: 5 },
  policy: "default",
  tank: { mode: "local", host: "mac" },
  memory: { scope: "bot" },
})

export const createBot = Effect.gen(function* () {
  const registry = yield* BotRegistry
  return yield* registry.upsert(NEW_BOT, "test")
})

export const specFor = (bot: Bot, over: Partial<Omit<TaskSpec, "id">> = {}): Omit<TaskSpec, "id"> => ({
  botId: bot.id,
  title: "Add a feature",
  prompt: "Implement the feature.",
  kind: "code",
  acceptance: ["tests pass"],
  budget: { tokens: 100000, seconds: 60, usd: 1 },
  tier: "light",
  origin: "api",
  ...over,
})

export const USAGE_EVENT: ExecutorEvent = {
  kind: "usage",
  usage: { tokensIn: 100, tokensOut: 50, cacheRead: 0, cacheWrite: 0, usd: 0.25, seconds: 3 },
}

export const SESSION = Schema.decodeUnknownSync(SessionId)("sess-1")

export const OK_EVENTS: ReadonlyArray<ExecutorEvent> = [
  { kind: "started", sessionId: SESSION },
  { kind: "text", text: "working" },
  USAGE_EVENT,
  { kind: "done", result: "all good", artifacts: [] },
]

export type FakeTank = {
  readonly shape: TankShape
  readonly prepared: Array<string>
  readonly released: Array<{ readonly keepWorktree: boolean }>
  // Every command the Lead ran in a Bot's Tank (argv), in order.
  readonly commands: Array<ReadonlyArray<string>>
}

const result = (exitCode: number, stdout = "", stderr = ""): ExecResult => ({
  exitCode,
  stdout,
  stderr,
  durationMs: 1,
  timedOut: false,
})

// Answers the delivery commands like a healthy repo with changes: git diff --cached exits 1 (something staged),
// gh opens a PR and prints its URL. Any other command succeeds silently.
export const HEALTHY_EXEC = (argv: ReadonlyArray<string>): ExecResult => {
  const program = argv.slice(0, 2).join(" ")
  if (program === "git diff") return result(1)
  if (program === "gh pr") return result(0, "https://github.com/renzer83/shoalwork-sandbox/pull/1\n")
  return result(0)
}

export const makeFakeTank = (
  opts: {
    readonly failPrepare?: boolean
    readonly hangPrepare?: boolean
    readonly exec?: (argv: ReadonlyArray<string>) => ExecResult
  } = {},
): FakeTank => {
  const prepared: Array<string> = []
  const commands: Array<ReadonlyArray<string>> = []
  const answer = opts.exec ?? HEALTHY_EXEC
  // Like the real Tank: a worktree kept for diagnosis blocks a second prepare with the same step id.
  const worktrees = new Set<string>()
  const released: Array<{ readonly keepWorktree: boolean }> = []
  const unused = () => Effect.die("not used by the Lead")
  const shape: TankShape = {
    mode: "local",
    prepare: (bot, step) =>
      opts.failPrepare === true
        ? Effect.fail(new TankError({ op: "prepare", cause: "disk full" }))
        : opts.hangPrepare === true
          ? Effect.never
          : step.repo !== undefined && worktrees.has(step.stepId)
            ? Effect.fail(
                new WorktreeConflict({ branch: `bot/${bot.name}/${step.stepId}`, path: "/work/wt" }),
              )
            : Effect.sync((): TankContext => {
                prepared.push(step.stepId)
                if (step.repo !== undefined) {
                  worktrees.add(step.stepId)
                }
                if (step.repo !== undefined) {
                  // Like the real Tank: a repo step runs in its own worktree on the Bot's branch.
                  const branch = `bot/${bot.name}/${step.stepId}`
                  return {
                    botId: bot.id,
                    botName: bot.name,
                    cwd: "/work/wt",
                    home: "/work/home",
                    env: {},
                    worktree: { path: "/work/wt", branch, repoDir: "/work/repo" },
                  }
                }
                return { botId: bot.id, botName: bot.name, cwd: "/work/cwd", home: "/work/home", env: {} }
              }),
    exec: (_ctx, cmd) =>
      Effect.sync(() => {
        commands.push(cmd)
        return answer(cmd)
      }),
    spawnStream: unused,
    readFile: unused,
    writeFile: unused,
    release: (_ctx, release) =>
      Effect.sync(() => {
        released.push({ keepWorktree: release.keepWorktree })
        if (!release.keepWorktree) {
          worktrees.clear()
        }
      }),
  }
  return { shape, prepared, released, commands }
}

export type Runs = Array<ExecutorTask>

// Executor whose stream is decided per call; `runs` records every task it was asked to execute.
export const fakeExecutor = (
  stream: (task: ExecutorTask) => ReturnType<Executor["run"]>,
  runs: Runs = [],
): Executor => ({
  id: CLAUDE,
  run: (task) => {
    runs.push(task)
    return stream(task)
  },
  mapTier: () => ({ model: "fake-model" }),
  quota: () => Effect.succeed({ executor: CLAUDE, usedRatio: 0, available: true }),
})

export const eventsOf = (events: ReadonlyArray<ExecutorEvent>) => () => Stream.fromIterable(events)

// A registry without the terminal-event guard, to exercise the Lead's own handling of a stream that just ends.
export const rawRegistry = (executor: Executor): Layer.Layer<ExecutorRegistry> =>
  Layer.succeed(ExecutorRegistry, {
    get: (id) => (id === executor.id ? Effect.succeed(executor) : Effect.die("unknown executor")),
    list: () => [executor.id],
  })

export const leadLayer = (opts: {
  readonly executor: Executor
  readonly tank?: FakeTank
  readonly config?: Partial<LeadConfig>
  readonly guarded?: boolean
  // Real Beacon over the same SQLite connection as the task tables (needed to prove transactional behaviour).
  readonly liveBeacon?: boolean
  // Wraps the real TaskStore, e.g. to make some writes fail.
  readonly wrapStore?: (real: TaskStoreShape) => TaskStoreShape
}) => {
  const tank = opts.tank ?? makeFakeTank()
  const registry = opts.guarded === false ? rawRegistry(opts.executor) : makeRegistry([opts.executor])
  const base = Layer.provideMerge(opts.liveBeacon === true ? BeaconLive : BeaconTest, withTempDb())
  const bots = Layer.provideMerge(BotRegistryLive, base)
  const wrap = opts.wrapStore ?? ((real: TaskStoreShape) => real)
  const store = Layer.provideMerge(
    Layer.effect(
      TaskStore,
      Effect.map(SqlClient, (sql) => wrap(makeTaskStore(sql))),
    ),
    bots,
  )
  const deps = Layer.provideMerge(Layer.merge(Layer.succeed(Tank, tank.shape), registry), store)
  return Layer.provideMerge(LeadLive(opts.config), deps)
}

export const allEvents = Effect.gen(function* () {
  const beacon = yield* Beacon
  return yield* Stream.runCollect(beacon.readAll())
})

export const eventTypes = Effect.map(allEvents, (events) => events.map((event) => event.type))

export { Lead }

// Task store whose writes of a final state (done|failed|waiting_approval) die, like a database that went away mid-run.
export const failFinalWrites = (real: TaskStoreShape): TaskStoreShape => ({
  ...real,
  update: (id, patch) =>
    patch.state === "done" || patch.state === "failed" || patch.state === "waiting_approval"
      ? Effect.die("database unavailable")
      : real.update(id, patch),
})
