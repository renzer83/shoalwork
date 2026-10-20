import { it } from "@effect/vitest"
import { Beacon, BeaconTest } from "@shoalwork/beacon"
import { SchemaViolation, streamIds } from "@shoalwork/contracts"
import { Effect, Layer, Stream } from "effect"
import { describe, expect } from "vitest"
import { belowThreshold, decodeReflexConfigText, limitsOf, loadReflexConfig } from "../src/config.js"
import { type Question, STANDARD_QUESTIONS } from "../src/contract.js"
import { makeReflexLive, Reflex } from "../src/reflex.js"
import { CLAUDE, config, DEV, factsFor, LEAD } from "./support.js"

const TestLayer = Layer.provideMerge(makeReflexLive(config), BeaconTest)

// Every append fails, as a broken database would.
const FailingBeacon: Layer.Layer<Beacon> = Layer.succeed(Beacon, {
  append: () => Effect.die(new Error("disk full")),
  appendMany: () => Effect.die(new Error("disk full")),
  readStream: () => Stream.empty,
  readAll: () => Stream.empty,
  subscribe: () => Effect.succeed(Stream.empty),
  lastVersion: () => Effect.succeed(0),
})

const FailingLayer = Layer.provideMerge(makeReflexLive(config), FailingBeacon)

// Text kept in a decision.made payload; "" when the shape is not the expected one.
const payloadText = (payload: unknown): string => {
  if (typeof payload !== "object" || payload === null || !("facts" in payload)) {
    return ""
  }
  const facts = payload.facts
  return typeof facts === "object" && facts !== null && "text" in facts && typeof facts.text === "string"
    ? facts.text
    : ""
}

const decisionEvents = (beacon: Beacon["Service"]) =>
  Effect.map(Stream.runCollect(beacon.readStream(streamIds.system)), (events) =>
    events.filter((event) => event.type === "decision.made"),
  )

describe("Reflex.ask", () => {
  it.effect("emits one decision.made per question, keyed by the returned decisionId", () =>
    Effect.gen(function* () {
      const reflex = yield* Reflex
      const beacon = yield* Beacon
      const answers = yield* reflex.ask(factsFor("implementa o login"))
      const events = yield* decisionEvents(beacon)
      expect(answers).toHaveLength(STANDARD_QUESTIONS.length)
      expect(events).toHaveLength(STANDARD_QUESTIONS.length)
      answers.forEach((answer, index) => {
        const event = events[index]
        expect(event?.payload).toMatchObject({
          decisionId: answer.decisionId,
          questionId: answer.id,
          value: answer.value,
          confidence: answer.confidence,
          source: "rule",
          facts: { text: "implementa o login" },
        })
        expect(event?.actor).toBe("system:reflex")
        expect(event?.streamId).toBe(streamIds.system)
      })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("groups the decisions of one ask under one correlationId, fresh per ask", () =>
    Effect.gen(function* () {
      const reflex = yield* Reflex
      const beacon = yield* Beacon
      yield* reflex.ask(factsFor("oi"))
      yield* reflex.ask(factsFor("tchau"))
      const events = yield* decisionEvents(beacon)
      const first = events.slice(0, STANDARD_QUESTIONS.length).map((e) => e.correlationId)
      const second = events.slice(STANDARD_QUESTIONS.length).map((e) => e.correlationId)
      expect(new Set(first).size).toBe(1)
      expect(new Set(second).size).toBe(1)
      expect(first[0]).not.toBe(second[0])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("uses the caller's correlationId when facts carry one", () =>
    Effect.gen(function* () {
      const reflex = yield* Reflex
      const beacon = yield* Beacon
      yield* reflex.ask(factsFor("oi", { correlationId: "msg_42" }))
      const events = yield* decisionEvents(beacon)
      expect(events.every((e) => e.correlationId === "msg_42")).toBe(true)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("truncates the text kept in the payload, not the answers", () =>
    Effect.gen(function* () {
      const reflex = yield* Reflex
      const beacon = yield* Beacon
      const long = `${"x".repeat(2500)} deploy`
      const answers = yield* reflex.ask(factsFor(long), [{ id: "risk", kind: "score", scale: [0, 3] }])
      const [event] = yield* decisionEvents(beacon)
      const kept = payloadText(event?.payload)
      expect(kept.length).toBe(2000 + "...[truncated]".length)
      expect(kept.startsWith("x".repeat(2000))).toBe(true)
      expect(answers.map((a) => [a.id, a.value])).toEqual([["risk", 3]])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("answers only the questions given", () =>
    Effect.gen(function* () {
      const reflex = yield* Reflex
      const only: ReadonlyArray<Question> = [{ id: "risk", kind: "score", scale: [0, 3] }]
      const answers = yield* reflex.ask(factsFor("deploy now"), only)
      expect(answers.map((a) => [a.id, a.value])).toEqual([["risk", 3]])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("emits nothing for an empty question list", () =>
    Effect.gen(function* () {
      const reflex = yield* Reflex
      const beacon = yield* Beacon
      const answers = yield* reflex.ask(factsFor("oi"), [])
      expect(answers).toHaveLength(0)
      expect(yield* decisionEvents(beacon)).toHaveLength(0)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("answers neutrally with confidence 0 for a question that has no rule", () =>
    Effect.gen(function* () {
      const reflex = yield* Reflex
      const answers = yield* reflex.ask(factsFor("oi"), [{ id: "mood", kind: "noul" }])
      expect(answers.map((a) => [a.id, a.value, a.confidence, a.source])).toEqual([
        ["mood", false, 0, "rule"],
      ])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("answers neutrally when the rule value does not fit the question kind", () =>
    Effect.gen(function* () {
      const reflex = yield* Reflex
      const answers = yield* reflex.ask(factsFor("deploy now"), [{ id: "risk", kind: "noul" }])
      expect(answers.map((a) => [a.value, a.confidence])).toEqual([[false, 0]])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("answers the first option with confidence 0 when the rule value is not in the options", () =>
    Effect.gen(function* () {
      const reflex = yield* Reflex
      const answers = yield* reflex.ask(factsFor("bom dia"), [
        { id: "intent", kind: "choice", options: ["code", "research"] },
      ])
      expect(answers.map((a) => [a.value, a.confidence])).toEqual([["code", 0]])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("answers the scale minimum with confidence 0 when the score is outside the scale", () =>
    Effect.gen(function* () {
      const reflex = yield* Reflex
      const answers = yield* reflex.ask(factsFor("implementa login, testa e faz deploy"), [
        { id: "complexity", kind: "score", scale: [0, 1] },
      ])
      expect(answers.map((a) => [a.value, a.confidence])).toEqual([[0, 0]])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("answers the owner and executor from the facts, not from the static options", () =>
    Effect.gen(function* () {
      const reflex = yield* Reflex
      const decision = yield* reflex.standard(factsFor("implementa o login"))
      expect(decision.owner).toBe(DEV)
      expect(decision.executor).toBe(CLAUDE)
      expect(decision.answers.find((a) => a.id === "owner")?.confidence).toBeGreaterThan(0)
    }).pipe(Effect.provide(TestLayer)),
  )
})

describe("Reflex with a failing Beacon", () => {
  it.effect("ask still returns the answers when decision.made cannot be stored", () =>
    Effect.gen(function* () {
      const reflex = yield* Reflex
      const answers = yield* reflex.ask(factsFor("implementa o login"))
      expect(answers).toHaveLength(STANDARD_QUESTIONS.length)
      expect(answers.find((a) => a.id === "intent")?.value).toBe("code")
    }).pipe(Effect.provide(FailingLayer)),
  )

  it.effect("standard still returns the typed decision when decision.made cannot be stored", () =>
    Effect.gen(function* () {
      const reflex = yield* Reflex
      const decision = yield* reflex.standard(factsFor("deploy to production now"))
      expect(decision.intent).toBe("code")
      expect(decision.risk).toBe(3)
      expect(decision.needsApproval).toBe(true)
      expect(decision.answers).toHaveLength(STANDARD_QUESTIONS.length)
    }).pipe(Effect.provide(FailingLayer)),
  )
})

describe("Reflex.standard", () => {
  it.effect("returns the typed standard decision and records its 8 answers", () =>
    Effect.gen(function* () {
      const reflex = yield* Reflex
      const beacon = yield* Beacon
      const decision = yield* reflex.standard(factsFor("deploy to production now"))
      expect(decision.intent).toBe("code")
      expect(decision.complexity).toBe(0)
      expect(decision.owner).toBe(DEV)
      expect(decision.executor).toBe(CLAUDE)
      expect(decision.parallelizable).toBe(false)
      expect(decision.risk).toBe(3)
      expect(decision.needsApproval).toBe(true)
      expect(decision.language).toBe("other")
      expect(decision.answers.map((a) => a.id)).toEqual(STANDARD_QUESTIONS.map((q) => q.id))
      expect(yield* decisionEvents(beacon)).toHaveLength(STANDARD_QUESTIONS.length)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("sends a routine chat message to lead with no approval needed", () =>
    Effect.gen(function* () {
      const reflex = yield* Reflex
      const decision = yield* reflex.standard(factsFor("bom dia, tudo bem?"))
      expect(decision.intent).toBe("chat")
      expect(decision.risk).toBe(0)
      expect(decision.needsApproval).toBe(false)
      expect(decision.owner).toBe(LEAD)
    }).pipe(Effect.provide(TestLayer)),
  )
})

describe("reflex config", () => {
  const yamlWith = (threshold: string, perQuestion: string, intentCode = "[fix]") =>
    [
      `thresholds:`,
      `  default: ${threshold}`,
      `  perQuestion: ${perQuestion}`,
      `intent: { code: ${intentCode}, research: [pesquisa], app_op: [posta], routine: [todo dia] }`,
      "verbs: [fix]",
      "sequence: [e depois]",
      "risk: { high: [deploy], external: [push], local: [edit] }",
      "language: { pt: [que], en: [the], es: [el] }",
      "owner: { roles: [dev], leadName: lead }",
    ].join("\n")

  it.effect("applies a per-question threshold from the yaml, default otherwise", () =>
    Effect.gen(function* () {
      const custom = yield* decodeReflexConfigText(yamlWith("0.6", "{ owner: 0.8 }"), "inline.yaml")
      expect(belowThreshold(custom, "owner", 0.7)).toBe(true)
      expect(belowThreshold(custom, "risk", 0.7)).toBe(false)
      expect(belowThreshold(custom, "risk", 0.59)).toBe(true)
      expect(belowThreshold(custom, "risk", 0.6)).toBe(false)
    }),
  )

  it.effect("loads the shipped thresholds: default 0.6 for every question", () =>
    Effect.sync(() => {
      expect(config.thresholds.default).toBe(0.6)
      expect(belowThreshold(config, "intent", 0.5)).toBe(true)
      expect(belowThreshold(config, "intent", 0.9)).toBe(false)
    }),
  )

  it.effect("uses the default limits when the yaml has none", () =>
    Effect.gen(function* () {
      const custom = yield* decodeReflexConfigText(yamlWith("0.6", "{}"), "inline.yaml")
      expect(limitsOf(custom)).toEqual({ ruleChars: 8000, payloadChars: 2000 })
    }),
  )

  it.effect("rejects a threshold outside 0..1 with SchemaViolation", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(decodeReflexConfigText(yamlWith("1.5", "{}"), "inline.yaml"))
      expect(error).toBeInstanceOf(SchemaViolation)
    }),
  )

  it.effect("rejects a perQuestion key that is not a standard question id", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decodeReflexConfigText(yamlWith("0.6", "{ mood: 0.5 }"), "inline.yaml"),
      )
      expect(error).toBeInstanceOf(SchemaViolation)
    }),
  )

  it.effect("rejects a word made only of spaces", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(decodeReflexConfigText(yamlWith("0.6", "{}", '["  "]'), "inline.yaml"))
      expect(error).toBeInstanceOf(SchemaViolation)
    }),
  )

  it.effect("rejects a config without the owner section", () =>
    Effect.gen(function* () {
      const text = yamlWith("0.6", "{}").replace(/owner:.*$/m, "")
      const error = yield* Effect.flip(decodeReflexConfigText(text, "inline.yaml"))
      expect(error).toBeInstanceOf(SchemaViolation)
    }),
  )

  it.effect("rejects invalid yaml with SchemaViolation at the given path", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(decodeReflexConfigText("thresholds: [unclosed", "bad.yaml"))
      expect(error).toBeInstanceOf(SchemaViolation)
      expect(error.where).toBe("bad.yaml")
    }),
  )

  it.effect("rejects a missing config file with SchemaViolation at its path", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(loadReflexConfig("does-not-exist/reflex.config.yaml"))
      expect(error).toBeInstanceOf(SchemaViolation)
      expect(error.where).toBe("does-not-exist/reflex.config.yaml")
    }),
  )
})
