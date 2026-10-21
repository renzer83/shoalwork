import {
  type ExecutorErrorCode,
  type ExecutorEvent,
  ExecutorId,
  type ExecutorProtocolError,
  ExecutorSpawnError,
  type ExecutorTask,
} from "@shoalwork/contracts"
import { Tank, type TankContext } from "@shoalwork/tank"
import { Duration, Effect, Schema, type Scope, Stream } from "effect"
import type { Executor, ExecutorContext } from "../executor.js"
import { parseNdjsonLines } from "../ndjson.js"
import { captureStderr, endedWithoutResult } from "../stderr.js"
import { buildArgs, defaultMapTier } from "./args.js"
import { GeminiStreamLine, makeMapperState, toExecutorEvents } from "./events.js"

export const GEMINI_ID = Schema.decodeUnknownSync(ExecutorId)("gemini")

export type GeminiOptions = {
  // Binary name or path; default "gemini" resolved on PATH.
  readonly bin?: string
  // Extra env for the CLI, applied after the Tank env. Overrides win over GEMINI_CLI_HOME (e.g. GEMINI_API_KEY).
  readonly envOverrides?: Readonly<Record<string, string>>
  readonly id?: ExecutorId
}

const spawnFailure = (cause: unknown): ExecutorSpawnError =>
  new ExecutorSpawnError({ executor: "gemini", cause })

const isTerminal = (event: ExecutorEvent): boolean => event.kind === "done" || event.kind === "error"

const one = (event: ExecutorEvent): Stream.Stream<ExecutorEvent> => Stream.make(event)

// Exit code 53 is the turn limit and 41 an authentication failure; other non-zero exits are unknown. A result with
// status error that arrived before the exit reports its message with the code from the exit.
export const endedEvent = (
  exitCode: number,
  failure: string | undefined,
  stderrTail: string,
): ExecutorEvent => {
  const code: ExecutorErrorCode = exitCode === 53 ? "max_turns" : exitCode === 41 ? "auth" : "unknown"
  if (failure !== undefined) return { kind: "error", code, message: failure }
  if (code !== "unknown")
    return { kind: "error", code, message: `gemini exited with code ${exitCode} without a result` }
  return endedWithoutResult("gemini", exitCode, stderrTail)
}

const runGemini = (
  task: ExecutorTask,
  ctx: ExecutorContext,
  bin: string,
  envOverrides: Readonly<Record<string, string>>,
): Stream.Stream<ExecutorEvent, ExecutorSpawnError | ExecutorProtocolError, Tank | Scope.Scope> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const tank = yield* Tank
      // The Bot's home is the Gemini CLI home: its settings and OAuth state live there (isolation per Bot).
      const runCtx: TankContext = {
        ...ctx,
        env: { ...ctx.env, GEMINI_CLI_HOME: ctx.home, ...envOverrides },
      }
      const proc = yield* tank
        .spawnStream(runCtx, [bin, ...buildArgs(task, defaultMapTier)])
        .pipe(Effect.mapError(spawnFailure))
      // gemini appends stdin to the prompt when stdin is piped; the prompt is the only input.
      yield* proc.closeStdin()
      const stderrTail = yield* captureStderr(proc.stderr.pipe(Stream.mapError(spawnFailure)))

      const state = makeMapperState(task.budget)
      let secondsExpired = false
      // Wall-clock budget: when it fires, the upstream is cut and the process is killed; `tail` reports it.
      const deadline = Effect.sleep(Duration.seconds(task.budget.seconds)).pipe(
        Effect.andThen(
          Effect.sync(() => {
            secondsExpired = true
          }),
        ),
        Effect.andThen(proc.kill()),
      )
      // Runs only when no terminal event was emitted: budget cut, or the process ended without a final event.
      const tail: Stream.Stream<ExecutorEvent> = Stream.unwrap(
        Effect.suspend((): Effect.Effect<Stream.Stream<ExecutorEvent>> => {
          if (state.finished) return Effect.succeed(Stream.empty)
          if (secondsExpired) {
            return Effect.succeed(
              one({
                kind: "error",
                code: "budget",
                message: `wall-clock budget of ${task.budget.seconds}s exceeded`,
              }),
            )
          }
          return Effect.map(
            Effect.all({ code: proc.exitCode, text: stderrTail }),
            ({ code, text }): Stream.Stream<ExecutorEvent> => one(endedEvent(code, state.failure, text)),
          )
        }),
      )

      const parse = parseNdjsonLines(GeminiStreamLine, "gemini")
      return parse(proc.stdout.pipe(Stream.mapError(spawnFailure))).pipe(
        Stream.flatMap((line) => Stream.fromIterable(toExecutorEvents(state, line))),
        Stream.takeUntil(isTerminal),
        Stream.interruptWhen(deadline),
        Stream.concat(tail),
        // Kills the process when the run ends early (terminal event, budget cut); a no-op after a normal exit.
        Stream.ensuring(proc.kill()),
      )
    }),
  )

export const makeGemini = (opts: GeminiOptions = {}): Executor => {
  const id = opts.id ?? GEMINI_ID
  const bin = opts.bin ?? "gemini"
  const envOverrides = opts.envOverrides ?? {}
  return {
    id,
    mapTier: defaultMapTier,
    // No local counter yet, as in claude-code: the real subscription quota is F5 work.
    quota: () => Effect.succeed({ executor: id, usedRatio: 0, available: true }),
    run: (task, ctx) => runGemini(task, ctx, bin, envOverrides),
  }
}
