import { it } from "@effect/vitest"
import { Beacon } from "@shoalwork/beacon"
import { EventPayloads, type NewEvent, streamIds } from "@shoalwork/contracts"
import { Effect, Schema, Stream } from "effect"
import { describe, expect } from "vitest"
import {
  allEvents,
  createBot,
  eventsOf,
  fakeExecutor,
  Lead,
  leadLayer,
  makeFakeTank,
  OK_EVENTS,
  specFor,
} from "./support.js"

const MESSAGE_ID = "evt_00000000-0000-4000-8000-0000000000e1"

const decision = (correlationId: string, decisionId: string, questionId: string): NewEvent => ({
  streamId: streamIds.system,
  type: "decision.made",
  payload: {
    decisionId,
    questionId,
    kind: "choice",
    value: "code",
    confidence: 0.9,
    source: "rule",
    facts: { text: "implementa o login" },
  },
  actor: "system:reflex",
  correlationId,
})

const DecisionOutcome = EventPayloads["decision.outcome"]

// Last outcome per decision: its label and the correlation id the event carries.
const outcomes = Effect.gen(function* () {
  const beacon = yield* Beacon
  const events = yield* Stream.runCollect(beacon.readAll(0, ["decision.outcome"]))
  const latest = new Map<string, { readonly outcome: string; readonly correlationId: string }>()
  for (const event of events) {
    const payload = yield* Schema.decodeUnknownEffect(DecisionOutcome)(event.payload)
    latest.set(payload.decisionId, { outcome: payload.outcome, correlationId: event.correlationId })
  }
  return latest
})

describe("task correlation", () => {
  it.effect("closes the decisions of the originating message when the task ends", () => {
    const layer = leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS)), tank: makeFakeTank() })
    return Effect.gen(function* () {
      const lead = yield* Lead
      const beacon = yield* Beacon
      const bot = yield* createBot
      const spec = yield* lead.intake({ ...specFor(bot), correlationId: MESSAGE_ID })
      expect(spec.correlationId).toBe(MESSAGE_ID)
      yield* beacon.appendMany([
        decision(MESSAGE_ID, "d-intent", "intent"),
        decision(MESSAGE_ID, "d-complexity", "complexity"),
        decision("evt_00000000-0000-4000-8000-0000000000e2", "d-other", "intent"),
      ])
      yield* lead.runOnce(spec.id)
      const latest = yield* outcomes
      expect(latest.get("d-intent")?.outcome).toBe("correct")
      expect(latest.get("d-complexity")?.outcome).toBe("unknown")
      expect(latest.get("d-intent")?.correlationId).toBe(MESSAGE_ID)
      // Another message's decision is not touched.
      expect(latest.has("d-other")).toBe(false)
    }).pipe(Effect.provide(layer))
  })

  it.effect("still joins by task id when the task has no correlationId", () => {
    const layer = leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS)), tank: makeFakeTank() })
    return Effect.gen(function* () {
      const lead = yield* Lead
      const beacon = yield* Beacon
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot))
      expect(spec.correlationId).toBeUndefined()
      yield* beacon.append(decision(spec.id, "d-intent", "intent"))
      yield* lead.runOnce(spec.id)
      const latest = yield* outcomes
      expect(latest.get("d-intent")?.outcome).toBe("correct")
    }).pipe(Effect.provide(layer))
  })
})

describe("intake tier", () => {
  it.effect("takes the tier from the routing table when the task names none, and keeps one it names", () => {
    const layer = leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS)), tank: makeFakeTank() })
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const { tier: _ignored, ...withoutTier } = specFor(bot, { kind: "code" })
      expect((yield* lead.intake(withoutTier)).tier).toBe("heavy")
      expect((yield* lead.intake({ ...withoutTier, kind: "routine" })).tier).toBe("light")
      expect((yield* lead.intake({ ...withoutTier, tier: "light" })).tier).toBe("light")
      expect((yield* allEvents).length).toBeGreaterThan(0)
    }).pipe(Effect.provide(layer))
  })
})
