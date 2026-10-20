import { Server } from "node:http"
import { serve as honoServe, type ServerType } from "@hono/node-server"
import { Data, Effect, type Scope } from "effect"
import type { Hono } from "hono"

export class ServeError extends Data.TaggedError("ServeError")<{
  readonly port: number
  readonly cause: unknown
}> {}

// Resolves once listening; fails with ServeError if the port cannot be bound.
const listen = (app: Hono, port: number): Effect.Effect<ServerType, ServeError> =>
  Effect.callback<ServerType, ServeError>((resume) => {
    const server = honoServe({ fetch: app.fetch, port }, () => resume(Effect.succeed(server)))
    server.once("error", (cause) => resume(Effect.fail(new ServeError({ port, cause }))))
  })

// Open keep-alive and SSE connections would otherwise keep close() waiting forever.
const close = (server: ServerType): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    server.close(() => resume(Effect.void))
    if (server instanceof Server) {
      server.closeAllConnections()
    }
  })

export const serve = (app: Hono, port: number): Effect.Effect<ServerType, ServeError, Scope.Scope> =>
  Effect.acquireRelease(listen(app, port), (server) =>
    close(server).pipe(Effect.andThen(Effect.logInfo("shutdown: http server closed"))),
  )
