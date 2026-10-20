import {
  type ExecutorErrorCode,
  type ExecutorEvent,
  ExecutorId,
  type ExecutorProtocolError,
  ExecutorSpawnError,
  type ExecutorTask,
  type ModelTier,
} from "@shoalwork/contracts"
import { Tank, type TankContext } from "@shoalwork/tank"
import { Duration, Effect, Option, Schema, type Scope, Stream } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import type { Executor } from "../executor.js"
import { buildChatArgs, CHAT_MODEL } from "./args.js"
import { dropApiKey } from "./env.js"
import { ClaudeStreamLine, makeMapperState, toExecutorEvents } from "./events.js"
import { ChatSessions } from "./sessions.js"

export const CHAT_ID = Schema.decodeUnknownSync(ExecutorId)("claude-code@chat")

export type ClaudeCodeChatOptions = {
  readonly bin?: string
  readonly envOverrides?: Readonly<Record<string, string>>
  // Wall-clock cap for one turn, shared by its attempts (spec: 20 s).
  readonly timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 20_000
const CHAT_TIERS: ReadonlySet<ModelTier> = new Set<ModelTier>(["chat", "decision"])

const failure = (code: ExecutorErrorCode, message: string): ExecutorEvent => ({
  kind: "error",
  code,
  message,
})

// Attempt outcome: the CLI ran past the timeout, or it finished. `resultReceived` is true when stdout held a
// `result` JSON document (answer or error); false when the CLI printed no result (e.g. unknown --resume id).
type Attempt =
  | { readonly kind: "timeout" }
  | {
      readonly kind: "output"
      readonly events: ReadonlyArray<ExecutorEvent>
      readonly resultReceived: boolean
    }

// Maps the single JSON document of `--output-format json` with the stream mapper (same result rules as stream-json).
// `seconds` is the wall-clock of this spawn, not the CLI's duration_ms.
const outputEvents = (
  stdout: ReadonlyArray<string>,
  exitCode: number,
  seconds: number,
): Effect.Effect<Pick<Extract<Attempt, { kind: "output" }>, "events" | "resultReceived">> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.option(
      Effect.try({ try: (): unknown => JSON.parse(stdout.join("\n")), catch: (cause) => cause }),
    )
    const line = Option.flatMap(parsed, (value) => Schema.decodeUnknownOption(ClaudeStreamLine)(value))
    const resultReceived = Option.isSome(line) && line.value.type === "result"
    const mapped: ReadonlyArray<ExecutorEvent> = Option.isSome(line)
      ? yield* toExecutorEvents(line.value, makeMapperState(CHAT_ID)).pipe(
          Effect.catchTag("ExecutorProtocolError", () =>
            Effect.succeed<ReadonlyArray<ExecutorEvent>>([
              failure("protocol", "chat output could not be mapped"),
            ]),
          ),
        )
      : []
    const events = mapped.map(
      (event): ExecutorEvent =>
        event.kind === "usage" ? { kind: "usage", usage: { ...event.usage, seconds } } : event,
    )
    if (events.some((event) => event.kind === "done" || event.kind === "error")) {
      return { events, resultReceived }
    }
    // No result line at all: the CLI exits non-zero on failure, e.g. an unknown --resume id, and prints no JSON.
    return {
      events: [
        exitCode !== 0
          ? failure("unknown", `claude exited with code ${exitCode} without a result`)
          : failure("protocol", "chat output had no result line"),
      ],
      resultReceived,
    }
  })

const runOnce = (
  bin: string,
  args: ReadonlyArray<string>,
  ctx: TankContext,
  env: Readonly<Record<string, string>>,
  timeoutMs: number,
): Effect.Effect<Attempt, ExecutorSpawnError, Tank | Scope.Scope> =>
  Effect.gen(function* () {
    const tank = yield* Tank
    const started = Date.now()
    const proc = yield* tank
      .spawnStream({ ...ctx, env }, [bin, ...args])
      .pipe(Effect.mapError((cause) => new ExecutorSpawnError({ executor: CHAT_ID, cause })))
    // The prompt travels in argv; with stdin open the CLI waits 3 s and warns.
    yield* proc.closeStdin()
    const readAll = Effect.all(
      {
        stdout: Stream.runCollect(proc.stdout).pipe(
          Effect.mapError((cause) => new ExecutorSpawnError({ executor: CHAT_ID, cause })),
        ),
        stderr: Stream.runDrain(proc.stderr).pipe(
          Effect.mapError((cause) => new ExecutorSpawnError({ executor: CHAT_ID, cause })),
        ),
        exitCode: proc.exitCode,
      },
      { concurrency: "unbounded" },
    )
    // Interrupted by the timeout: the process is killed here, not left running.
    const finished = yield* readAll.pipe(
      Effect.onInterrupt(() => proc.kill()),
      Effect.timeoutOption(Duration.millis(timeoutMs)),
    )
    if (Option.isNone(finished)) return { kind: "timeout" }
    const seconds = Math.round((Date.now() - started) / 1000)
    const output = yield* outputEvents([...finished.value.stdout], finished.value.exitCode, seconds)
    return { kind: "output", ...output }
  })

const runTurn = (
  bin: string,
  task: ExecutorTask,
  ctx: TankContext,
  envOverrides: Readonly<Record<string, string>>,
  timeoutMs: number,
): Stream.Stream<ExecutorEvent, ExecutorSpawnError, Tank | Scope.Scope> =>
  Stream.unwrap(
    Effect.gen(function* () {
      if (!CHAT_TIERS.has(task.tier)) {
        return Stream.make(failure("unknown", "tier not supported by chat mode"))
      }
      const env = dropApiKey({ ...ctx.env, ...envOverrides })
      const timedOut = failure("unknown", `chat turn exceeded ${timeoutMs} ms`)
      const started = Date.now()
      const first = yield* runOnce(bin, buildChatArgs(task), ctx, env, timeoutMs)
      if (first.kind === "timeout") return Stream.make(timedOut)
      // Retry only when the resumed turn printed no result (the CLI case for an unknown session). A result that
      // carries an error (rate limit, max turns) is returned as is and the stored session is left alone.
      if (task.resumeSessionId === undefined || first.resultReceived) {
        return Stream.fromIterable(first.events)
      }
      // The retry gets what is left of the same budget.
      const remaining = timeoutMs - (Date.now() - started)
      if (remaining <= 0) return Stream.make(timedOut)
      const { resumeSessionId: _failed, ...fresh } = task
      const retry = yield* runOnce(bin, buildChatArgs(fresh), ctx, env, remaining)
      if (retry.kind === "timeout") return Stream.make(timedOut)
      return Stream.fromIterable(retry.events)
    }),
  )

export const makeClaudeCodeChat = (opts: ClaudeCodeChatOptions = {}): Executor => {
  const bin = opts.bin ?? "claude"
  const envOverrides = dropApiKey(opts.envOverrides ?? {})
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return {
    id: CHAT_ID,
    run: (task, ctx) => runTurn(bin, task, ctx, envOverrides, timeoutMs),
    // light and heavy are refused by run(), so this mapping is never used for them.
    mapTier: (): { readonly model: string; readonly effort: "low" } => ({ model: CHAT_MODEL, effort: "low" }),
    // No local counter in T-017; the subscription quota is F5 work.
    quota: () => Effect.succeed({ executor: CHAT_ID, usedRatio: 0, available: true }),
  }
}

// One turn of a conversation: resumes the scope's session when there is one and stores the session id of the
// `done` event, so the next turn of the same scope resumes it. The whole turn (get → run → set) holds the scope's
// lock, so two messages of one topic never run at the same time. A failed save is logged; the events still arrive.
export const runChatTurn = (
  executor: Executor,
  scope: string,
  task: ExecutorTask,
  ctx: TankContext,
): Stream.Stream<
  ExecutorEvent,
  ExecutorSpawnError | ExecutorProtocolError | SqlError,
  Tank | Scope.Scope | ChatSessions
> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const sessions = yield* ChatSessions
      const events = yield* sessions.withScope(
        scope,
        Effect.gen(function* () {
          const previous = yield* sessions.get(scope)
          const turn: ExecutorTask = Option.isSome(previous)
            ? { ...task, resumeSessionId: previous.value }
            : task
          const collected = yield* Stream.runCollect(executor.run(turn, ctx))
          for (const event of collected) {
            if (event.kind === "done" && event.sessionId !== undefined) {
              yield* sessions.set(scope, event.sessionId).pipe(
                Effect.matchEffect({
                  onFailure: () =>
                    Effect.logWarning("chat session not stored; the next turn of this scope starts fresh"),
                  onSuccess: () => Effect.void,
                }),
              )
            }
          }
          return collected
        }),
      )
      return Stream.fromIterable(events)
    }),
  )
