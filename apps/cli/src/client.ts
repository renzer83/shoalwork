import { SchemaViolation } from "@shoalwork/contracts"
import { Data, Effect, Schema } from "effect"

export class HttpError extends Data.TaggedError("HttpError")<{ status: number; body: string }> {}

// Mirrors the body of GET /health (HealthBody in services/core/src/http/app.ts).
export const Health = Schema.Struct({
  ok: Schema.Boolean,
  version: Schema.String,
  db: Schema.Literals(["ok", "error"]),
  dbPath: Schema.NullOr(Schema.String),
  journalMode: Schema.NullOr(Schema.String),
  uptimeSeconds: Schema.Int,
})
export type Health = typeof Health.Type

// No HTTP response was received (connection refused, DNS, aborted).
const TRANSPORT_FAILURE = 0

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

export class ApiClient {
  constructor(
    readonly baseUrl: string,
    readonly token: string,
  ) {}

  get<A>(path: string, schema: Schema.Codec<A, unknown>): Effect.Effect<A, HttpError | SchemaViolation> {
    return this.request("GET", path, undefined, schema)
  }

  post<A>(
    path: string,
    body: unknown,
    schema: Schema.Codec<A, unknown>,
  ): Effect.Effect<A, HttpError | SchemaViolation> {
    return this.request("POST", path, body, schema)
  }

  // Raw body for non-JSON responses (NDJSON exports). The caller decides what the text means.
  getText(path: string): Effect.Effect<string, HttpError> {
    return this.send("GET", path, undefined, "application/x-ndjson, application/json")
  }

  private request<A>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    schema: Schema.Codec<A, unknown>,
  ): Effect.Effect<A, HttpError | SchemaViolation> {
    const where = `${method} ${path}`
    return this.send(method, path, body, "application/json").pipe(
      Effect.flatMap((text) =>
        Effect.try({
          try: (): unknown => JSON.parse(text),
          catch: () => new SchemaViolation({ where, issue: "response is not JSON" }),
        }),
      ),
      Effect.flatMap((raw) =>
        Schema.decodeUnknownEffect(schema)(raw).pipe(
          Effect.mapError((cause) => new SchemaViolation({ where, issue: cause.message })),
        ),
      ),
    )
  }

  private send(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    accept: string,
  ): Effect.Effect<string, HttpError> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}${path}`
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept,
    }
    const init: RequestInit =
      body === undefined
        ? { method, headers }
        : { method, headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) }

    return Effect.gen(function* () {
      const res = yield* Effect.tryPromise({
        try: () => fetch(url, init),
        catch: (cause) =>
          new HttpError({ status: TRANSPORT_FAILURE, body: `request failed: ${messageOf(cause)}` }),
      })
      const text = yield* Effect.tryPromise({
        try: () => res.text(),
        catch: (cause) => new HttpError({ status: res.status, body: `unreadable body: ${messageOf(cause)}` }),
      })
      if (!res.ok) {
        return yield* Effect.fail(new HttpError({ status: res.status, body: text }))
      }
      return text
    })
  }
}
