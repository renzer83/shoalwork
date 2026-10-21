import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  BotId,
  type ExecutorEvent,
  ExecutorId,
  type ExecutorTask,
  type PolicyDecision,
  TankError,
  TaskId,
  type ToolCall,
} from "@shoalwork/contracts"
import { type ExecResult, Tank, type TankContext, type TankShape } from "@shoalwork/tank"
import { Effect, Schema, Stream } from "effect"
import type { Executor } from "../../src/executor.js"
import { type FetchLike, makeOpenAICompat, type OpenAICompatOptions } from "../../src/openai-compat/index.js"

export const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/openai-compat/${name}`, import.meta.url)), "utf8")

export const CWD = "/tank/bot-a/work/step-1"
export const HOME = "/tank/bot-a/home"

export const BOT = Schema.decodeUnknownSync(BotId)("bot_00000000-0000-4000-8000-000000000001")

export const ctx: TankContext = { botId: BOT, botName: "bot-a", cwd: CWD, home: HOME, env: { HOME } }

export const task = (overrides: Partial<ExecutorTask> = {}): ExecutorTask => ({
  taskId: Schema.decodeUnknownSync(TaskId)("task_00000000-0000-4000-8000-000000000002"),
  botId: BOT,
  prompt: "say pong",
  tier: "light",
  allowedTools: [],
  permissionMode: "edit",
  maxTurns: 5,
  budget: { tokens: 1_000_000, seconds: 600, usd: 10 },
  ...overrides,
})

export const sse = (text: string, status = 200): Response =>
  new Response(text, { status, headers: { "content-type": "text/event-stream" } })

export type Recorded = {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: Record<string, unknown>
}

// Serves the scripted responses in order (the last one repeats) and records every request.
export const scriptedFetch = (responses: ReadonlyArray<() => Response>) => {
  const requests: Array<Recorded> = []
  const fetcher: FetchLike = async (url, init) => {
    const body = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(JSON.parse(init.body))
    requests.push({ url, headers: init.headers, body })
    const next = responses[Math.min(requests.length - 1, responses.length - 1)]
    if (next === undefined) throw new Error("no scripted response")
    return next()
  }
  return { fetcher, requests }
}

export const OK_EXEC: ExecResult = { exitCode: 0, stdout: "hi\n", stderr: "", durationMs: 1, timedOut: false }

export type TankCalls = {
  readonly exec: Array<ReadonlyArray<string>>
  readonly execOpts: Array<{
    readonly maxOutputBytes?: number | undefined
    readonly timeoutMs?: number | undefined
  }>
  readonly written: Array<{ readonly path: string; readonly content: string }>
  readonly read: Array<string>
}

export const fakeTank = (
  options: {
    readonly exec?: (cmd: ReadonlyArray<string>) => ExecResult
    readonly files?: Readonly<Record<string, string>>
    // realpath answers that differ from the input (symlinks).
    readonly links?: Readonly<Record<string, string>>
  } = {},
) => {
  const calls: TankCalls = { exec: [], execOpts: [], written: [], read: [] }
  const unused = () => Effect.die("not used by the openai-compat executor")
  const shape: TankShape = {
    mode: "local",
    prepare: unused,
    spawnStream: unused,
    writeHomeFile: unused,
    worktrees: unused,
    removeWorktree: unused,
    release: unused,
    exec: (_ctx, cmd, execOpts) =>
      Effect.sync(() => {
        calls.exec.push(cmd)
        calls.execOpts.push({ maxOutputBytes: execOpts?.maxOutputBytes, timeoutMs: execOpts?.timeoutMs })
        if (cmd[0] === "realpath")
          return { ...OK_EXEC, stdout: `${options.links?.[cmd[2] ?? ""] ?? cmd[2]}\n` }
        if (cmd[0] === "test") {
          const known = options.files?.[cmd[2] ?? ""] !== undefined
          return { ...OK_EXEC, exitCode: known ? 0 : 1, stdout: "" }
        }
        if (cmd[0] === "wc") {
          const content = options.files?.[cmd[2] ?? ""]
          return content === undefined
            ? { ...OK_EXEC, exitCode: 1 }
            : { ...OK_EXEC, stdout: `${Buffer.byteLength(content)} ${cmd[2]}\n` }
        }
        return options.exec?.(cmd) ?? OK_EXEC
      }),
    readFile: (_ctx, path) => {
      calls.read.push(path)
      const content = options.files?.[path]
      return content === undefined
        ? Effect.fail(new TankError({ op: "read", cause: "missing" }))
        : Effect.succeed(content)
    },
    writeFile: (_ctx, path, content) =>
      Effect.sync(() => {
        calls.written.push({ path, content })
      }),
  }
  return { shape, calls }
}

export const policyOf = (
  effect: PolicyDecision["effect"] | ((call: ToolCall) => PolicyDecision["effect"]),
) => {
  const seen: Array<ToolCall> = []
  const policy = (_bot: BotId, call: ToolCall): Effect.Effect<PolicyDecision> =>
    Effect.sync(() => {
      seen.push(call)
      return { effect: typeof effect === "function" ? effect(call) : effect, risk: "write_local" as const }
    })
  return { policy, seen }
}

export const collect = (executor: Executor, runTask: ExecutorTask, shape: TankShape) =>
  Stream.runCollect(executor.run(runTask, ctx)).pipe(Effect.scoped, Effect.provideService(Tank, shape))

export const kinds = (events: ReadonlyArray<ExecutorEvent>): ReadonlyArray<string> =>
  events.map((event) => event.kind)

export const ID = Schema.decodeUnknownSync(ExecutorId)("ollama")

export const build = (
  script: ReturnType<typeof scriptedFetch>,
  policy: OpenAICompatOptions["policy"],
  extra: Partial<OpenAICompatOptions> = {},
) =>
  makeOpenAICompat({
    id: ID,
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "qwen3:8b",
    supportsTools: true,
    policy,
    fetch: script.fetcher,
    retryBase: "1 millis",
    ...extra,
  })

export const text = () => sse(fixture("stream-text.sse"))
export const toolcall = () => sse(fixture("stream-toolcall.sse"))

// One streamed tool call that finishes with finish_reason tool_calls.
export const toolCallStream = (name: string, args: string): string =>
  `data: ${JSON.stringify({
    choices: [
      {
        index: 0,
        delta: { tool_calls: [{ index: 0, id: "call_1", function: { name, arguments: args } }] },
        finish_reason: "tool_calls",
      },
    ],
  })}\n\ndata: [DONE]\n\n`
