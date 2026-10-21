import {
  type ExecutorEvent,
  ExecutorId,
  type ExecutorProtocolError,
  ExecutorSpawnError,
  type ExecutorTask,
  SessionId,
} from "@shoalwork/contracts"
import { Tank } from "@shoalwork/tank"
import { Effect, Schema, type Scope, Stream } from "effect"
import type { Executor, ExecutorContext } from "../executor.js"
import { parseNdjsonLines } from "../ndjson.js"
import { captureStderr, endedWithoutResult } from "../stderr.js"

// The forja contract is UNVERIFIED: the binary was not available when this was written (T-080). The line shape below is
// presumed from the task; a task that receives the real spec replaces it and its synthetic fixture.
export const FORJA_ID = Schema.decodeUnknownSync(ExecutorId)("forja")

export type ForjaOptions = {
  readonly bin: string
  // Presence of the binary on this host. Without it the executor reports available=false and refuses to run.
  readonly onPath: (bin: string) => boolean
}

// Tolerant line: only `type` is required; every other field may be absent. An unknown type is ignored.
const ForjaLine = Schema.Struct({
  type: Schema.String,
  text: Schema.optionalKey(Schema.String),
  result: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  sessionId: Schema.optionalKey(SessionId),
  cmd: Schema.optionalKey(Schema.String),
  exitCode: Schema.optionalKey(Schema.Int),
  output: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.String),
  diff: Schema.optionalKey(Schema.String),
  usage: Schema.optionalKey(
    Schema.Struct({
      tokensIn: Schema.optionalKey(Schema.Int),
      tokensOut: Schema.optionalKey(Schema.Int),
      usd: Schema.optionalKey(Schema.Number),
    }),
  ),
})
type ForjaLine = typeof ForjaLine.Type

// Maps one line to zero or one event. A type this adapter does not know yields nothing (tolerant).
const eventOf = (line: ForjaLine): ExecutorEvent | undefined => {
  switch (line.type) {
    case "started":
      return line.sessionId === undefined
        ? { kind: "started" }
        : { kind: "started", sessionId: line.sessionId }
    case "text":
      return { kind: "text", text: line.text ?? "" }
    case "command":
      return {
        kind: "command",
        cmd: line.cmd ?? "",
        ...(line.exitCode === undefined ? {} : { exitCode: line.exitCode }),
        ...(line.output === undefined ? {} : { output: line.output }),
      }
    case "file_edit":
      return {
        kind: "file_edit",
        path: line.path ?? "",
        ...(line.diff === undefined ? {} : { diff: line.diff }),
      }
    case "usage":
      return {
        kind: "usage",
        usage: {
          tokensIn: line.usage?.tokensIn ?? 0,
          tokensOut: line.usage?.tokensOut ?? 0,
          cacheRead: 0,
          cacheWrite: 0,
          usd: line.usage?.usd ?? 0,
          seconds: 0,
        },
      }
    case "done":
      return {
        kind: "done",
        result: line.result ?? line.text ?? "",
        artifacts: [],
        ...(line.sessionId === undefined ? {} : { sessionId: line.sessionId }),
      }
    case "error":
      return { kind: "error", code: "unknown", message: line.message ?? "forja reported an error" }
    default:
      return undefined
  }
}

const isTerminal = (event: ExecutorEvent): boolean => event.kind === "done" || event.kind === "error"

const RECOGNIZED = new Set(["started", "text", "command", "file_edit", "usage", "done", "error"])

export const makeForja = (options: ForjaOptions): Executor => {
  const present = (): boolean => options.onPath(options.bin)
  const spawnFailed = (cause: unknown) => new ExecutorSpawnError({ executor: FORJA_ID, cause })

  const run = (
    task: ExecutorTask,
    ctx: ExecutorContext,
  ): Stream.Stream<ExecutorEvent, ExecutorSpawnError | ExecutorProtocolError, Tank | Scope.Scope> =>
    Stream.unwrap(
      Effect.gen(function* () {
        if (!present()) {
          return yield* Effect.fail(spawnFailed("forja binary not found on PATH"))
        }
        const tank = yield* Tank
        // `--` ends option parsing: the prompt travels last and is never read as a flag (convention §11).
        const proc = yield* tank
          .spawnStream(ctx, [options.bin, "run", "--json", "--", task.prompt])
          .pipe(Effect.mapError(spawnFailed))
        yield* proc.closeStdin()
        const stderrTail = yield* captureStderr(proc.stderr.pipe(Stream.mapError(spawnFailed)))
        let terminal = false
        let recognized = 0
        const parse = parseNdjsonLines(ForjaLine, FORJA_ID)
        const events = parse(proc.stdout.pipe(Stream.mapError(spawnFailed))).pipe(
          Stream.tap((line) =>
            Effect.sync(() => {
              if (RECOGNIZED.has(line.type)) recognized += 1
            }),
          ),
          Stream.map(eventOf),
          Stream.flatMap((event) => (event === undefined ? Stream.empty : Stream.make(event))),
          Stream.tap((event) =>
            Effect.sync(() => {
              if (isTerminal(event)) terminal = true
            }),
          ),
        )
        // Stdout ended without done|error: no recognized line at all is a protocol failure; otherwise report how the
        // process ended, with the redacted stderr tail.
        const tail: Stream.Stream<ExecutorEvent> = Stream.unwrap(
          Effect.suspend((): Effect.Effect<Stream.Stream<ExecutorEvent>> => {
            if (terminal) return Effect.succeed(Stream.empty)
            if (recognized === 0) {
              const protocol: ExecutorEvent = {
                kind: "error",
                code: "protocol",
                message: "forja output had no recognized event",
              }
              return Effect.succeed(Stream.make(protocol))
            }
            return Effect.map(Effect.all({ code: proc.exitCode, text: stderrTail }), ({ code, text }) =>
              Stream.make(endedWithoutResult("forja", code, text)),
            )
          }),
        )
        return events.pipe(Stream.concat(tail), Stream.ensuring(proc.kill()))
      }),
    )

  return {
    id: FORJA_ID,
    run,
    mapTier: () => ({ model: "default" }),
    quota: () => Effect.succeed({ executor: FORJA_ID, usedRatio: 0, available: present() }),
  }
}
