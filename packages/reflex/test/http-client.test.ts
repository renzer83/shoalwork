import { Beacon, BeaconTest } from "@shoalwork/beacon"
import { streamIds } from "@shoalwork/contracts"
import { Effect, Layer, Redacted, Stream } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { STANDARD_QUESTIONS } from "../src/contract.js"
import { ReflexHttpLive } from "../src/http-client.js"
import { Reflex } from "../src/reflex.js"
import { config, DEV, factsFor } from "./support.js"

const BASE = "http://reflex.test:8300"

// Fake credentials are assembled at run time so the source text never looks like a secret to a scanner.
const part = (...pieces: ReadonlyArray<string>): string => pieces.join("")

const standardAnswers = [
  { id: "intent", value: "code", confidence: 0.8, source: "model" },
  { id: "complexity", value: 2, confidence: 0.7, source: "model" },
  { id: "owner", value: DEV, confidence: 0.9, source: "model" },
  { id: "executor", value: "claude-code", confidence: 0.6, source: "model" },
  { id: "parallelizable", value: false, confidence: 0.6, source: "model" },
  { id: "risk", value: 0, confidence: 0.5, source: "model" },
  { id: "needs_approval", value: false, confidence: 0.5, source: "model" },
  { id: "language", value: "pt", confidence: 0.9, source: "model" },
]

const okBody = (answers: ReadonlyArray<unknown>) => ({ answers, modelVersion: "rules-py-1", latencyMs: 1.5 })

const respond = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

type Call = {
  readonly url: string
  readonly headers: Headers
  readonly redirect: RequestInit["redirect"]
}
const calls: Array<Call> = []

// Replaces fetch for one test. The handler sees each call in order, starting at 0.
const stubFetch = (handler: (index: number, init: RequestInit | undefined) => Promise<Response>): void => {
  let index = 0
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), headers: new Headers(init?.headers), redirect: init?.redirect })
    const current = index
    index += 1
    return handler(current, init)
  }
}

const hangsUntilAborted = (_index: number, init: RequestInit | undefined): Promise<Response> =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))
  })

const layerWith = (options: { readonly timeoutMs?: number; readonly token?: Redacted.Redacted<string> }) =>
  Layer.provideMerge(
    ReflexHttpLive(config, { url: BASE, timeoutMs: options.timeoutMs ?? 2000, token: options.token }),
    BeaconTest,
  )

const decisionsOf = Effect.gen(function* () {
  const beacon = yield* Beacon
  return yield* Stream.runCollect(beacon.readStream(streamIds.system))
})

const hasRaised = (events: Iterable<{ readonly type: string; readonly payload: unknown }>): boolean =>
  [...events].some(
    (event) => event.type === "error.raised" && JSON.stringify(event.payload).includes("reflex.http"),
  )

afterEach(() => {
  calls.length = 0
  globalThis.fetch = originalFetch
})

const originalFetch = globalThis.fetch

describe("ReflexHttpLive", () => {
  it("uses the remote answers that fit and records each decision with its source", async () => {
    stubFetch(async () => respond(okBody(standardAnswers)))
    const program = Effect.gen(function* () {
      const reflex = yield* Reflex
      const decision = yield* reflex.standard(factsFor("implementa o login"))
      const events = yield* decisionsOf
      return { decision, decisions: [...events].filter((e) => e.type === "decision.made") }
    }).pipe(Effect.provide(layerWith({})))
    const { decision, decisions } = await Effect.runPromise(program)
    expect(decision.intent).toBe("code")
    expect(decision.owner).toBe(DEV)
    expect(decision.answers.find((answer) => answer.id === "intent")?.source).toBe("model")
    expect(decisions).toHaveLength(STANDARD_QUESTIONS.length)
    expect(calls[0]?.url).toBe(`${BASE}/v1/systemone`)
  })

  it("sends the token in the X-Reflex-Token header", async () => {
    stubFetch(async () => respond(okBody(standardAnswers)))
    await Effect.runPromise(
      Effect.gen(function* () {
        const reflex = yield* Reflex
        yield* reflex.ask(factsFor("oi"), STANDARD_QUESTIONS)
      }).pipe(Effect.provide(layerWith({ token: Redacted.make("tok-secret") }))),
    )
    expect(calls[0]?.headers.get("x-reflex-token")).toBe("tok-secret")
  })

  it("a timeout retries once, then falls back to the rules and records error.raised", async () => {
    stubFetch(hangsUntilAborted)
    const program = Effect.gen(function* () {
      const reflex = yield* Reflex
      const records = yield* reflex.ask(factsFor("implementa o login"), STANDARD_QUESTIONS)
      const events = yield* decisionsOf
      return { records, events: [...events] }
    }).pipe(Effect.provide(layerWith({ timeoutMs: 20 })))
    const { records, events } = await Effect.runPromise(program)
    expect(calls).toHaveLength(2)
    expect(records.find((record) => record.id === "intent")?.source).toBe("rule")
    expect(hasRaised(events)).toBe(true)
  })

  it("an HTTP error falls back to the rules", async () => {
    stubFetch(async () => respond({ error: "boom" }, 500))
    const program = Effect.gen(function* () {
      const reflex = yield* Reflex
      return yield* reflex.standard(factsFor("implementa o login"))
    }).pipe(Effect.provide(layerWith({})))
    const decision = await Effect.runPromise(program)
    expect(decision.intent).toBe("code")
    expect(decision.answers.every((answer) => answer.source === "rule")).toBe(true)
  })

  it("a 4xx is not retried and falls back to the rules", async () => {
    stubFetch(async () => respond({ error: "bad request" }, 422))
    const program = Effect.gen(function* () {
      const reflex = yield* Reflex
      return yield* reflex.ask(factsFor("implementa o login"), STANDARD_QUESTIONS)
    }).pipe(Effect.provide(layerWith({})))
    const records = await Effect.runPromise(program)
    expect(calls).toHaveLength(1)
    expect(records.every((record) => record.source === "rule")).toBe(true)
  })

  it("a body outside the contract falls back to the rules", async () => {
    stubFetch(async () => respond({ answers: "not a list" }))
    const program = Effect.gen(function* () {
      const reflex = yield* Reflex
      return yield* reflex.ask(factsFor("implementa o login"), STANDARD_QUESTIONS)
    }).pipe(Effect.provide(layerWith({})))
    const records = await Effect.runPromise(program)
    expect(records.every((record) => record.source === "rule")).toBe(true)
  })

  it("an answer that does not fit its question is neutral with confidence 0", async () => {
    stubFetch(async () => respond(okBody([{ id: "intent", value: 42, confidence: 0.9, source: "model" }])))
    const program = Effect.gen(function* () {
      const reflex = yield* Reflex
      return yield* reflex.ask(factsFor("implementa o login"), STANDARD_QUESTIONS)
    }).pipe(Effect.provide(layerWith({})))
    const records = await Effect.runPromise(program)
    const intent = records.find((record) => record.id === "intent")
    expect(intent?.value).toBe("chat")
    expect(intent?.confidence).toBe(0)
  })

  it("retries once and uses the second answer", async () => {
    stubFetch(async (index) => {
      if (index === 0) {
        throw new TypeError("fetch failed")
      }
      return respond(okBody(standardAnswers))
    })
    const program = Effect.gen(function* () {
      const reflex = yield* Reflex
      return yield* reflex.ask(factsFor("implementa o login"), STANDARD_QUESTIONS)
    }).pipe(Effect.provide(layerWith({})))
    const records = await Effect.runPromise(program)
    expect(calls).toHaveLength(2)
    expect(records.find((record) => record.id === "intent")?.source).toBe("model")
  })
  it("a source the schema does not know (llm) falls back to the rules", async () => {
    stubFetch(async () => respond(okBody([{ id: "intent", value: "code", confidence: 0.9, source: "llm" }])))
    const program = Effect.gen(function* () {
      const reflex = yield* Reflex
      const records = yield* reflex.ask(factsFor("implementa o login"), STANDARD_QUESTIONS)
      const events = yield* decisionsOf
      return { records, events: [...events] }
    }).pipe(Effect.provide(layerWith({})))
    const { records, events } = await Effect.runPromise(program)
    expect(records.every((record) => record.source === "rule")).toBe(true)
    expect(hasRaised(events)).toBe(true)
  })

  it("an answer shape the standard decision cannot read falls back to the rules", async () => {
    stubFetch(async () =>
      respond(okBody([{ id: "complexity", value: 2.5, confidence: 0.9, source: "model" }])),
    )
    const program = Effect.gen(function* () {
      const reflex = yield* Reflex
      return yield* reflex.standard(factsFor("implementa o login"))
    }).pipe(Effect.provide(layerWith({})))
    const decision = await Effect.runPromise(program)
    expect(decision.complexity).not.toBe(2.5)
    expect(decision.answers.every((answer) => answer.source === "rule")).toBe(true)
  })

  it("the token never appears in error.raised", async () => {
    const secret = part("tok-never-", "logged-", "7f3a")
    stubFetch(async () => respond({ error: "boom" }, 500))
    const program = Effect.gen(function* () {
      const reflex = yield* Reflex
      yield* reflex.ask(factsFor("implementa o login"), STANDARD_QUESTIONS)
      const events = yield* decisionsOf
      return [...events]
    }).pipe(Effect.provide(layerWith({ token: Redacted.make(secret) })))
    const events = await Effect.runPromise(program)
    expect(hasRaised(events)).toBe(true)
    expect(JSON.stringify(events)).not.toContain(secret)
  })

  it("normalizes the configured URL and refuses redirects", async () => {
    stubFetch(async () => respond(okBody(standardAnswers)))
    const program = Effect.gen(function* () {
      const reflex = yield* Reflex
      return yield* reflex.ask(factsFor("oi"), STANDARD_QUESTIONS)
    }).pipe(Effect.provide(Layer.provideMerge(ReflexHttpLive(config, { url: `  ${BASE}//  ` }), BeaconTest)))
    await Effect.runPromise(program)
    expect(calls[0]?.url).toBe(`${BASE}/v1/systemone`)
    expect(calls[0]?.redirect).toBe("error")
  })

  it("a body that stalls while being read is a timeout, retried once, then the rules answer", async () => {
    stubFetch(async (_index, init) => {
      const stalled = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason))
        },
      })
      return new Response(stalled, { status: 200, headers: { "content-type": "application/json" } })
    })
    const program = Effect.gen(function* () {
      const reflex = yield* Reflex
      const records = yield* reflex.ask(factsFor("implementa o login"), STANDARD_QUESTIONS)
      const events = yield* decisionsOf
      return { records, events: [...events] }
    }).pipe(Effect.provide(layerWith({ timeoutMs: 20 })))
    const { records, events } = await Effect.runPromise(program)
    expect(calls).toHaveLength(2)
    expect(records.every((record) => record.source === "rule")).toBe(true)
    expect(JSON.stringify(events)).toContain("timeout:")
  })
})
