import { type Stream as AcpStream, ndJsonStream } from "@agentclientprotocol/sdk"
import type { RunningProcess } from "@shoalwork/tank"
import { Effect, type Scope, Stream } from "effect"

// The Tank hands a process as lines of text; the ACP SDK wants byte streams. This turns one into the other:
// each stdout line becomes a newline-terminated chunk, and stdin writes are decoded back to text. The SDK calls
// back from plain promises, so the effects it triggers run with the services of the run that opened it.
export const openTransport = (proc: RunningProcess): Effect.Effect<AcpStream, never, Scope.Scope> =>
  Effect.gen(function* () {
    const run = Effect.runPromiseWith(yield* Effect.context<never>())
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const input = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c
      },
    })
    const settle = (end: (c: ReadableStreamDefaultController<Uint8Array>) => void): void => {
      try {
        if (controller !== undefined) end(controller)
      } catch {
        // already closed by the reader
      }
    }
    yield* proc.stdout.pipe(
      Stream.runForEach((line) =>
        Effect.sync(() => {
          controller?.enqueue(encoder.encode(`${line}\n`))
        }),
      ),
      Effect.matchCause({
        onSuccess: () => settle((c) => c.close()),
        onFailure: () => settle((c) => c.error(new Error("agent output could not be read"))),
      }),
      Effect.forkScoped,
    )
    const output = new WritableStream<Uint8Array>({
      write: (chunk) => run(proc.writeStdin(decoder.decode(chunk, { stream: true }))),
      close: () => run(proc.closeStdin()),
    })
    return ndJsonStream(output, input)
  })

// Runs an effect for the SDK: its handlers need the typed error itself (a RequestError becomes the JSON-RPC error
// response), not the FiberFailure that a plain run would wrap around it.
export const makeRunRequest =
  (run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>) =>
  <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
    run(
      effect.pipe(
        Effect.match({
          onSuccess: (value) => ({ ok: true as const, value }),
          onFailure: (error) => ({ ok: false as const, error }),
        }),
      ),
    ).then((result) => (result.ok ? result.value : Promise.reject(result.error)))
