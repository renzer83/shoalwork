import { Beacon, type BeaconShape } from "@shoalwork/beacon"
import { BotId, ExecutorId, newEventId, streamIds } from "@shoalwork/contracts"
import { Data, Effect, Layer, Redacted, Schema } from "effect"
import type { ReflexConfig } from "./config.js"
import {
  type AnswerRecord,
  type Facts,
  fitsQuestion,
  type Question,
  STANDARD_QUESTIONS,
  type StandardDecision,
} from "./contract.js"
import { makeReflex, neutralFor, Reflex, recordDecisions } from "./reflex.js"
import { compileRules } from "./rules.js"

const ENDPOINT = "/v1/systemone"
const DEFAULT_TIMEOUT_MS = 2000
const RETRY_TIMES = 1

export interface ReflexHttpOptions {
  readonly url: string
  readonly token?: Redacted.Redacted<string> | undefined
  readonly timeoutMs?: number | undefined
}

// reason "timeout" | "transport" | "http" | "decode" | "shape": every one of them falls back to the rules.
export class ReflexHttpError extends Data.TaggedError("ReflexHttpError")<{
  readonly reason: "timeout" | "transport" | "http" | "decode" | "shape"
  readonly status?: number | undefined
  readonly detail: string
}> {}

const RemoteAnswer = Schema.Struct({
  id: Schema.String,
  value: Schema.Union([Schema.Boolean, Schema.String, Schema.Number]),
  confidence: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  source: Schema.Literals(["rule", "model", "cache"]),
})

const RemoteResponse = Schema.Struct({
  answers: Schema.Array(RemoteAnswer),
  modelVersion: Schema.String,
  latencyMs: Schema.Number,
})

// The standard decision, read back from the answers of the standard questions.
const StandardValues = Schema.Struct({
  intent: Schema.Literals(["chat", "system", "code", "research", "app_op", "routine"]),
  complexity: Schema.Int,
  owner: Schema.Union([BotId, Schema.Literal("new")]),
  executor: Schema.Union([ExecutorId, Schema.Literal("none")]),
  parallelizable: Schema.Boolean,
  risk: Schema.Int,
  needs_approval: Schema.Boolean,
  language: Schema.Literals(["pt", "en", "es", "other"]),
})

type Row = { readonly question: Question; readonly record: AnswerRecord }
type Remote = typeof RemoteResponse.Type
type CorrelatedFacts = Facts & { readonly correlationId: string }

// Network failures, timeouts and 5xx are transient and retried once; a 4xx or a bad body is not.
const isRetryable = (error: ReflexHttpError): boolean =>
  error.reason === "transport" ||
  error.reason === "timeout" ||
  (error.reason === "http" && (error.status ?? 0) >= 500)

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

const isTimeout = (cause: unknown): boolean => cause instanceof Error && cause.name === "TimeoutError"

// Every failure of the call is one of ReflexHttpError's reasons; `otherwise` names the reason for a non-timeout.
const failure = (cause: unknown, otherwise: ReflexHttpError["reason"]): ReflexHttpError =>
  new ReflexHttpError({ reason: isTimeout(cause) ? "timeout" : otherwise, detail: messageOf(cause) })

// The configured base URL: spaces and trailing slashes around it are not part of the address.
const normalizeUrl = (url: string): string => url.trim().replace(/\/+$/, "")

// The facts on the wire are the rule inputs only; the TypeScript correlation id stays on this side.
const wireFacts = (facts: Facts) => ({
  text: facts.text,
  channel: facts.channel,
  userId: facts.userId,
  botHint: facts.botHint,
  bots: facts.bots,
  executors: facts.executors,
  hasRepo: facts.hasRepo,
  language: facts.language,
})

// One POST to /v1/systemone. The token travels in a header and is never logged; redirects are refused.
const postOnce = (
  options: ReflexHttpOptions,
  facts: Facts,
  questions: ReadonlyArray<Question>,
): Effect.Effect<Remote, ReflexHttpError> =>
  Effect.gen(function* () {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const headers: Record<string, string> = { "content-type": "application/json" }
    if (options.token !== undefined) {
      headers["x-reflex-token"] = Redacted.value(options.token)
    }
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(`${normalizeUrl(options.url)}${ENDPOINT}`, {
          method: "POST",
          headers,
          redirect: "error",
          body: JSON.stringify({ facts: wireFacts(facts), questions }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        }),
      catch: (cause) => failure(cause, "transport"),
    })
    if (!response.ok) {
      return yield* Effect.fail(
        new ReflexHttpError({ reason: "http", status: response.status, detail: `HTTP ${response.status}` }),
      )
    }
    // The body is read under the same signal, so a stall while reading is a timeout too.
    const json = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (cause) => failure(cause, "decode"),
    })
    return yield* Schema.decodeUnknownEffect(RemoteResponse)(json).pipe(
      Effect.mapError((cause) => new ReflexHttpError({ reason: "decode", detail: cause.message })),
    )
  }).pipe(Effect.retry({ times: RETRY_TIMES, while: isRetryable }))

// A remote answer is used only when it fits its question; otherwise the question gets the neutral value at 0.
const rowsFrom = (facts: Facts, questions: ReadonlyArray<Question>, remote: Remote): ReadonlyArray<Row> =>
  questions.map((question): Row => {
    const answer = remote.answers.find((candidate) => candidate.id === question.id)
    if (answer !== undefined && fitsQuestion(question, answer.value, facts)) {
      return {
        question,
        record: {
          id: question.id,
          value: answer.value,
          confidence: answer.confidence,
          source: answer.source,
          decisionId: newEventId(),
        },
      }
    }
    return {
      question,
      record: {
        id: question.id,
        value: neutralFor(question, facts),
        confidence: 0,
        source: "rule",
        decisionId: newEventId(),
      },
    }
  })

type Attempt<T> =
  | { readonly _tag: "Remote"; readonly rows: ReadonlyArray<Row>; readonly value: T }
  | { readonly _tag: "Failed"; readonly error: ReflexHttpError }

export const ReflexHttpLive = (
  config: ReflexConfig,
  options: ReflexHttpOptions,
): Layer.Layer<Reflex, never, Beacon> =>
  Layer.effect(
    Reflex,
    Effect.gen(function* () {
      const beacon: BeaconShape = yield* Beacon
      const compiled = compileRules(config)
      const fallback = makeReflex(beacon, compiled)

      // Asks the service, then checks what the caller needs (`check`) before anything is recorded.
      const attempt = <T>(
        facts: Facts,
        questions: ReadonlyArray<Question>,
        check: (rows: ReadonlyArray<Row>) => Effect.Effect<T, ReflexHttpError>,
      ): Effect.Effect<Attempt<T>, never> =>
        postOnce(options, facts, questions).pipe(
          Effect.flatMap((remote) => {
            const rows = rowsFrom(facts, questions, remote)
            return Effect.map(check(rows), (value): Attempt<T> => ({ _tag: "Remote", rows, value }))
          }),
          Effect.catch((error: ReflexHttpError) => Effect.succeed<Attempt<T>>({ _tag: "Failed", error })),
        )

      // The failure is logged and recorded as error.raised; the rules then answer, so the caller never sees it.
      const reportFailure = (facts: CorrelatedFacts, error: ReflexHttpError): Effect.Effect<void, never> =>
        Effect.gen(function* () {
          yield* Effect.logWarning(
            `reflex: HTTP backend failed (${error.reason}); the TypeScript rules answer`,
          )
          yield* beacon
            .append({
              streamId: streamIds.system,
              type: "error.raised",
              payload: { where: "reflex.http", tag: error._tag, message: `${error.reason}: ${error.detail}` },
              actor: "system:reflex",
              correlationId: facts.correlationId,
            })
            .pipe(Effect.catchCause(() => Effect.logError("reflex: error.raised not persisted")))
        })

      const withId = (facts: Facts): CorrelatedFacts => ({
        ...facts,
        correlationId: facts.correlationId ?? newEventId(),
      })
      const noCheck = (): Effect.Effect<undefined, never> => Effect.succeed(undefined)

      return {
        ask: (facts, questions = STANDARD_QUESTIONS) => {
          const id = withId(facts)
          return Effect.gen(function* () {
            const outcome = yield* attempt(id, questions, noCheck)
            if (outcome._tag === "Failed") {
              yield* reportFailure(id, outcome.error)
              return yield* fallback.ask(id, questions)
            }
            yield* recordDecisions(beacon, compiled.payloadChars, id.correlationId, id, outcome.rows)
            return outcome.rows.map((row) => row.record)
          })
        },
        standard: (facts): Effect.Effect<StandardDecision, never> => {
          const id = withId(facts)
          const checkStandard = (rows: ReadonlyArray<Row>) =>
            Schema.decodeUnknownEffect(StandardValues)(
              Object.fromEntries(rows.map((row) => [row.record.id, row.record.value])),
            ).pipe(
              Effect.mapError((cause) => new ReflexHttpError({ reason: "shape", detail: cause.message })),
            )
          return Effect.gen(function* () {
            const outcome = yield* attempt(id, STANDARD_QUESTIONS, checkStandard)
            if (outcome._tag === "Failed") {
              yield* reportFailure(id, outcome.error)
              return yield* fallback.standard(id)
            }
            yield* recordDecisions(beacon, compiled.payloadChars, id.correlationId, id, outcome.rows)
            const values = outcome.value
            return {
              intent: values.intent,
              complexity: values.complexity,
              owner: values.owner,
              executor: values.executor,
              parallelizable: values.parallelizable,
              risk: values.risk,
              needsApproval: values.needs_approval,
              language: values.language,
              answers: outcome.rows.map((row) => row.record),
            }
          })
        },
      }
    }),
  )
