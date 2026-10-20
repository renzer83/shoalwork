import { readFileSync } from "node:fs"
import { BeaconTest } from "@shoalwork/beacon"
import {
  BotId,
  type ExecutorEvent,
  ExecutorId,
  type ExecutorTask,
  type PolicyDecision,
  type PolicyEffect,
  type Risk,
  SessionId,
  TaskId,
  type ToolCall,
} from "@shoalwork/contracts"
import { makePolicyTest, Policy } from "@shoalwork/policy"
import { Tank, type TankContext, type TankShape } from "@shoalwork/tank"
import { Effect, Layer, Schema, Stream } from "effect"
import { type AcpPolicy, makeAcp } from "../../src/acp/index.js"
import type { Executor } from "../../src/executor.js"
import { type FakeAgent, type FakeAgentOptions, startFakeAgent } from "./fake-agent.js"

export const CWD = "/tank/bot-a/work/step-1"
export const BOT = Schema.decodeUnknownSync(BotId)("bot_00000000-0000-4000-8000-000000000001")
export const ID = Schema.decodeUnknownSync(ExecutorId)("acp-fake")
export const sessionIdOf = (value: string) => Schema.decodeUnknownSync(SessionId)(value)

export const ctx: TankContext = {
  botId: BOT,
  botName: "bot-a",
  cwd: CWD,
  home: "/tank/bot-a/home",
  env: { HOME: "/tank/bot-a/home" },
}

export const task = (overrides: Partial<ExecutorTask> = {}): ExecutorTask => ({
  taskId: Schema.decodeUnknownSync(TaskId)("task_00000000-0000-4000-8000-000000000002"),
  botId: BOT,
  prompt: "say pong",
  tier: "heavy",
  allowedTools: [],
  permissionMode: "edit",
  maxTurns: 10,
  budget: { tokens: 1_000_000, seconds: 600, usd: 10 },
  ...overrides,
})

// Decides by tool name; anything not listed asks. Records what the adapter asked.
export const fakePolicy = (
  decisions: Readonly<Record<string, PolicyEffect>>,
  risk: Risk = "write_local",
): { readonly policy: AcpPolicy; readonly asked: Array<ToolCall> } => {
  const asked: Array<ToolCall> = []
  const policy: AcpPolicy = (_bot, call): Effect.Effect<PolicyDecision> => {
    asked.push(call)
    return Effect.succeed({ effect: decisions[call.tool] ?? "ask", risk })
  }
  return { policy, asked }
}

export const tankServing = (agent: FakeAgent, overrides: Partial<TankShape> = {}) => {
  const argvs: Array<ReadonlyArray<string>> = []
  const unused = () => Effect.die("not used by the ACP executor")
  const shape: TankShape = {
    mode: "local",
    prepare: unused,
    exec: unused,
    spawnStream: (_ctx, cmd) =>
      Effect.sync(() => {
        argvs.push(cmd)
        return agent.proc
      }),
    readFile: unused,
    writeFile: unused,
    writeHomeFile: unused,
    worktrees: unused,
    removeWorktree: unused,
    release: unused,
    ...overrides,
  }
  return { shape, argvs }
}

export const executorWith = (policy: AcpPolicy): Executor =>
  makeAcp({
    id: ID,
    bin: "fake-acp",
    args: ["--acp"],
    policy,
    quotaWindowSeconds: 3600,
    quotaSoftLimitTokens: 1_000_000,
  })

export const collect = (executor: Executor, runTask: ExecutorTask, shape: TankShape) =>
  Stream.runCollect(executor.run(runTask, ctx)).pipe(Effect.scoped, Effect.provideService(Tank, shape))

export const kinds = (events: ReadonlyArray<ExecutorEvent>): ReadonlyArray<string> =>
  events.map((event) => event.kind)

// One whole run against an in-process agent.
export const runAgent = (
  agentOptions: FakeAgentOptions,
  policy: AcpPolicy,
  runTask: ExecutorTask = task(),
  tankOverrides: Partial<TankShape> = {},
) =>
  Effect.gen(function* () {
    const agent = yield* startFakeAgent(agentOptions)
    const { shape, argvs } = tankServing(agent, tankOverrides)
    const events = yield* collect(executorWith(policy), runTask, shape)
    return { events, agent, argvs }
  })

// The product policy (config/policies/default.yaml) in memory. `evaluate` is what the adapter gets in production.
export const DEFAULT_POLICY_YAML = readFileSync(
  new URL("../../../../config/policies/default.yaml", import.meta.url),
  "utf8",
)
const realLayer = makePolicyTest({
  sources: { default: DEFAULT_POLICY_YAML },
  policyOf: () => "default",
}).pipe(Layer.provideMerge(BeaconTest))

// Runs `body` with the real Policy; `spy` lists every call it was asked about.
export const withRealPolicy = <A, E>(
  body: (policy: AcpPolicy, spy: Array<ToolCall>) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const real = yield* Policy
    const spy: Array<ToolCall> = []
    const policy: AcpPolicy = (bot, call, context) => {
      spy.push(call)
      return real.evaluate(bot, call, context)
    }
    return yield* body(policy, spy)
  }).pipe(Effect.provide(realLayer))
