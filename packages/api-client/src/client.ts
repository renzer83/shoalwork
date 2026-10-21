import { type EventType, SchemaViolation, TaskSpec } from "@shoalwork/contracts"
import { Effect, Schema, Struct } from "effect"
import { HttpError } from "./errors.js"
import {
  ApprovalList,
  ApprovalResolved,
  BotList,
  BotOne,
  CostReport,
  EventList,
  HealthBody,
  MemoryHits,
  ProjectList,
  TaskCreated,
  TaskView,
  TideList,
} from "./schemas.js"

type Method = "GET" | "POST" | "PATCH" | "DELETE"

// Body of POST /tasks: the spec without the id, which the core assigns.
export const NewTaskBody = TaskSpec.mapFields(Struct.omit(["id"]))
export type NewTaskBody = typeof NewTaskBody.Encoded

export interface EventsQuery {
  readonly stream: string
  readonly after?: number
  readonly types?: ReadonlyArray<EventType>
}

export interface MemoryQuery {
  readonly bot: string
  readonly q: string
  readonly k?: number
  readonly kinds?: ReadonlyArray<string>
}

export interface CostsQuery {
  readonly by?: "task" | "bot" | "executor"
  readonly since?: string
  readonly until?: string
  readonly compareWith?: string
}

const withQuery = (path: string, params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, String(value))
    }
  }
  const text = search.toString()
  return text === "" ? path : `${path}?${text}`
}

const readBody = async (response: Response): Promise<unknown> => {
  const text = await response.text()
  if (text === "") {
    return null
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

// Transport and decode only: no business rule lives here (backend first).
export class ApiClient {
  constructor(
    readonly baseUrl: string,
    readonly getToken: () => Promise<string | null>,
    readonly fetchImpl: typeof fetch = fetch,
  ) {}

  url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, "")}${path}`
  }

  // Headers every request carries; the SSE reader adds Accept and Last-Event-ID on top.
  authHeaders(): Effect.Effect<Record<string, string>, HttpError> {
    return Effect.tryPromise({
      try: this.getToken,
      catch: (cause) =>
        new HttpError({ status: 0, body: cause instanceof Error ? cause.message : String(cause) }),
    }).pipe(
      Effect.map(
        (token): Record<string, string> => (token === null ? {} : { authorization: `Bearer ${token}` }),
      ),
    )
  }

  // Raw call shared with the SSE reader. A network failure is an HttpError with status 0.
  send(
    method: Method,
    path: string,
    init: {
      readonly body?: unknown
      readonly headers?: Record<string, string>
      readonly signal?: AbortSignal
    },
  ): Effect.Effect<Response, HttpError> {
    return this.authHeaders().pipe(
      Effect.flatMap((auth) =>
        Effect.tryPromise({
          try: () => {
            // Called detached: browsers throw "Illegal invocation" when fetch runs with another receiver.
            const run = this.fetchImpl
            const hasBody = init.body !== undefined
            return run(this.url(path), {
              method,
              headers: {
                ...(hasBody ? { "content-type": "application/json" } : {}),
                ...auth,
                ...init.headers,
              },
              ...(hasBody ? { body: JSON.stringify(init.body) } : {}),
              ...(init.signal === undefined ? {} : { signal: init.signal }),
            })
          },
          catch: (cause) =>
            new HttpError({ status: 0, body: cause instanceof Error ? cause.message : String(cause) }),
        }),
      ),
    )
  }

  request<A>(
    method: Method,
    path: string,
    body: unknown,
    schema: Schema.Decoder<A>,
  ): Effect.Effect<A, HttpError | SchemaViolation> {
    return this.send(method, path, { body }).pipe(
      Effect.flatMap((response) =>
        Effect.tryPromise({
          try: () => readBody(response),
          catch: (cause) =>
            new HttpError({
              status: response.status,
              body: cause instanceof Error ? cause.message : String(cause),
            }),
        }).pipe(
          Effect.flatMap((parsed) =>
            response.ok
              ? Effect.succeed(parsed)
              : Effect.fail(new HttpError({ status: response.status, body: parsed })),
          ),
        ),
      ),
      Effect.flatMap((parsed) =>
        Schema.decodeUnknownEffect(schema)(parsed).pipe(
          Effect.mapError((error) => new SchemaViolation({ where: `${method} ${path}`, issue: error.issue })),
        ),
      ),
    )
  }

  get<A>(path: string, schema: Schema.Decoder<A>) {
    return this.request("GET", path, undefined, schema)
  }

  post<A>(path: string, body: unknown, schema: Schema.Decoder<A>) {
    return this.request("POST", path, body, schema)
  }

  patch<A>(path: string, body: unknown, schema: Schema.Decoder<A>) {
    return this.request("PATCH", path, body, schema)
  }

  del<A>(path: string, schema: Schema.Decoder<A>) {
    return this.request("DELETE", path, undefined, schema)
  }

  health() {
    // /health answers 503 with the same body when the database is down; the app wants to show that, not an error.
    return this.send("GET", "/health", {}).pipe(
      Effect.flatMap((response) =>
        Effect.tryPromise({
          try: () => readBody(response),
          catch: () => new HttpError({ status: response.status, body: null }),
        }).pipe(
          Effect.flatMap((parsed) =>
            Schema.decodeUnknownEffect(HealthBody)(parsed).pipe(
              Effect.mapError((error) =>
                response.ok
                  ? new SchemaViolation({ where: "GET /health", issue: error.issue })
                  : new HttpError({ status: response.status, body: parsed }),
              ),
            ),
          ),
        ),
      ),
    )
  }

  readonly bots = {
    list: () => this.get("/bots", BotList),
    get: (idOrName: string) => this.get(`/bots/${encodeURIComponent(idOrName)}`, BotOne),
  }

  readonly tasks = {
    create: (spec: NewTaskBody) =>
      Schema.encodeUnknownEffect(NewTaskBody)(spec).pipe(
        Effect.mapError((error) => new SchemaViolation({ where: "POST /tasks", issue: error.issue })),
        Effect.flatMap((body) => this.post("/tasks", body, TaskCreated)),
      ),
    get: (id: string) => this.get(`/tasks/${encodeURIComponent(id)}`, TaskView),
  }

  readonly events = {
    list: (query: EventsQuery) =>
      this.get(
        withQuery("/events", {
          stream: query.stream,
          after: query.after,
          types: query.types?.join(","),
        }),
        EventList,
      ),
  }

  readonly approvals = {
    list: (status?: string) => this.get(withQuery("/approvals", { status }), ApprovalList),
    resolve: (id: string, decision: "approved" | "denied") =>
      this.post(`/approvals/${encodeURIComponent(id)}`, { decision, via: "web" }, ApprovalResolved),
  }

  readonly memory = {
    search: (query: MemoryQuery) =>
      this.get(
        withQuery("/memory", { bot: query.bot, q: query.q, k: query.k, kinds: query.kinds?.join(",") }),
        MemoryHits,
      ),
  }

  readonly projects = {
    list: () => this.get("/projects", ProjectList),
  }

  readonly tides = {
    list: (bot?: string) => this.get(withQuery("/tides", { bot }), TideList),
  }

  costs(query: CostsQuery = {}) {
    return this.get(
      withQuery("/costs", {
        by: query.by,
        since: query.since,
        until: query.until,
        compareWith: query.compareWith,
      }),
      CostReport,
    )
  }
}
