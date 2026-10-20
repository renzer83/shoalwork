import type { ExecutorEvent } from "@shoalwork/contracts"
import { Duration, Effect, Fiber, Ref, type Scope, Stream } from "effect"

// Last characters of stderr kept for diagnostics. Only the redacted tail ever leaves an adapter.
export const STDERR_TAIL_CHARS = 4096

// How long the run waits for stderr to close after stdout ends; a grandchild may hold the pipe open.
const STDERR_WAIT = Duration.seconds(1)

const URL_CREDENTIALS = /:\/\/[^@/\s]+@/g
const SECRET_LINE = /token|key|secret|password/i

const keepTail = (text: string): string =>
  text.length > STDERR_TAIL_CHARS ? text.slice(text.length - STDERR_TAIL_CHARS) : text

// Lines naming a token or key are dropped whole; URLs with user info keep only the scheme and host.
export const redactStderr = (text: string): string =>
  text
    .split("\n")
    .map((line) => (SECRET_LINE.test(line) ? "[redacted]" : line.replace(URL_CREDENTIALS, "://***@")))
    .join("\n")

// Terminal event for a process that ended without a done|error line. Exit 0 is a protocol failure; any other exit is
// unknown. The redacted stderr tail, when present, is appended to the message.
export const endedWithoutResult = (label: string, exitCode: number, stderrTail: string): ExecutorEvent => {
  const ended =
    exitCode === 0
      ? `${label} ended without a result`
      : `${label} exited with code ${exitCode} without a result`
  return {
    kind: "error",
    code: exitCode === 0 ? "protocol" : "unknown",
    message: stderrTail === "" ? ended : `${ended}; stderr: ${stderrTail}`,
  }
}

// Drains stderr in a scope-bound fiber for the whole run, so the pipe never fills up. The returned effect yields the
// redacted tail once the stream has ended (or after a short wait when it does not end).
export const captureStderr = <E>(
  stderr: Stream.Stream<string, E>,
): Effect.Effect<Effect.Effect<string>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const buffer = yield* Ref.make("")
    const drain = yield* stderr.pipe(
      Stream.runForEach((line) => Ref.update(buffer, (text) => keepTail(`${text}${line}\n`))),
      Effect.catchCause(() => Effect.logWarning("executor stderr could not be read")),
      Effect.forkScoped,
    )
    return Fiber.join(drain).pipe(
      Effect.timeoutOption(STDERR_WAIT),
      Effect.andThen(Ref.get(buffer)),
      Effect.map((text) => redactStderr(text.trimEnd())),
    )
  })
