import { it } from "@effect/vitest"
import { Beacon, BeaconTest } from "@shoalwork/beacon"
import { type NewEvent, NotFound, SchemaViolation, streamIds, TaskId } from "@shoalwork/contracts"
import { Effect, Schema, Stream } from "effect"
import { describe, expect } from "vitest"
import { isTerminal, makeOutcomes, outcomeFor } from "../src/outcomes.js"
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

const TASK = Schema.decodeUnknownSync(TaskId)("task_00000000-0000-4000-8000-0000000000aa")
const OTHER_TASK = Schema.decodeUnknownSync(TaskId)("task_00000000-0000-4000-8000-0000000000bb")

// A decision.made as the Reflex writes it, for the given task correlation.
const decisionMade = (correlationId: string, decisionId: string, questionId: string): NewEvent => ({
  streamId: streamIds.system,
  type: "decision.made",
  payload: {
    decisionId,
    questionId,
    kind: "choice",
    value: "code",
    confidence: 0.9,
    source: "rule",
    facts: {
      text: "implementa o login",
      channel: "telegram",
      userId: "42",
      bots: [],
      executors: [],
      hasRepo: false,
    },
  },
  actor: "system:reflex",
  correlationId,
})

const QUESTIONS: ReadonlyArray<readonly [string, string]> = [
  ["d-intent", "intent"],
  ["d-owner", "owner"],
  ["d-executor", "executor"],
  ["d-complexity", "complexity"],
]

const decisionsFor = (correlationId: string): ReadonlyArray<NewEvent> =>
  QUESTIONS.map(([decisionId, questionId]) => decisionMade(correlationId, decisionId, questionId))

// Outcome of each decision, as the log holds them now (last one wins).
const outcomesNow = Effect.gen(function* () {
  const beacon = yield* Beacon
  const events = yield* Stream.runCollect(beacon.readAll(0, ["decision.outcome"]))
  const latest = new Map<string, { readonly outcome: string; readonly note?: string }>()
  for (const event of Array.from(events)) {
    const payload = event.payload as {
      readonly decisionId: string
      readonly outcome: string
      readonly note?: string
    }
    latest.set(payload.decisionId, payload)
  }
  return latest
})

const appendAll = (events: ReadonlyArray<NewEvent>) =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    yield* beacon.appendMany(events)
  })

describe("outcomeFor", () => {
  it("confirms intent, owner and executor only when the task is done", () => {
    expect(outcomeFor("intent", "done")).toBe("correct")
    expect(outcomeFor("owner", "done")).toBe("correct")
    expect(outcomeFor("executor", "done")).toBe("correct")
    expect(outcomeFor("complexity", "done")).toBe("unknown")
    expect(outcomeFor("risk", "done")).toBe("unknown")
  })

  it("leaves every decision unknown when the task did not finish ok", () => {
    expect(outcomeFor("intent", "failed")).toBe("unknown")
    expect(outcomeFor("owner", "cancelled")).toBe("unknown")
  })

  it("treats done, failed and cancelled as terminal, and nothing else", () => {
    expect(isTerminal("done")).toBe(true)
    expect(isTerminal("failed")).toBe(true)
    expect(isTerminal("cancelled")).toBe(true)
    expect(isTerminal("waiting_approval")).toBe(false)
    expect(isTerminal("running")).toBe(false)
  })
})

describe("makeOutcomes", () => {
  it.effect("records one outcome per decision of the task and skips other tasks", () =>
    Effect.gen(function* () {
      yield* appendAll([...decisionsFor(TASK), decisionMade(OTHER_TASK, "d-other", "intent")])
      const outcomes = makeOutcomes(yield* Beacon)
      const written = yield* outcomes.recordTaskOutcomes(TASK, "done")

      expect(written).toBe(4)
      const latest = yield* outcomesNow
      expect(latest.get("d-intent")?.outcome).toBe("correct")
      expect(latest.get("d-owner")?.outcome).toBe("correct")
      expect(latest.get("d-executor")?.outcome).toBe("correct")
      expect(latest.get("d-complexity")?.outcome).toBe("unknown")
      expect(latest.has("d-other")).toBe(false)
    }).pipe(Effect.provide(BeaconTest)),
  )

  it.effect("does not duplicate an outcome that already exists", () =>
    Effect.gen(function* () {
      yield* appendAll(decisionsFor(TASK))
      const outcomes = makeOutcomes(yield* Beacon)
      expect(yield* outcomes.recordTaskOutcomes(TASK, "done")).toBe(4)
      expect(yield* outcomes.recordTaskOutcomes(TASK, "done")).toBe(0)

      const beacon = yield* Beacon
      const written = yield* Stream.runCollect(beacon.readAll(0, ["decision.outcome"]))
      expect(Array.from(written)).toHaveLength(4)
    }).pipe(Effect.provide(BeaconTest)),
  )

  it.effect("records a human correction as corrected_by_human and keeps it the last outcome", () =>
    Effect.gen(function* () {
      yield* appendAll(decisionsFor(TASK))
      const outcomes = makeOutcomes(yield* Beacon)
      yield* outcomes.recordTaskOutcomes(TASK, "done")

      const text = { kind: "text", note: "devia ir para o writer" } as const
      expect(yield* outcomes.recordHumanCorrection("d-intent", text)).toBe(true)
      expect(yield* outcomes.recordHumanCorrection("d-intent", text)).toBe(false)

      const latest = yield* outcomesNow
      expect(latest.get("d-intent")).toEqual({
        decisionId: "d-intent",
        outcome: "corrected_by_human",
        note: "devia ir para o writer",
      })
      expect(latest.get("d-owner")?.outcome).toBe("correct")
    }).pipe(Effect.provide(BeaconTest)),
  )

  it.effect("fails with NotFound when the decision does not exist", () =>
    Effect.gen(function* () {
      const outcomes = makeOutcomes(yield* Beacon)
      const failure = yield* outcomes
        .recordHumanCorrection("d-missing", { kind: "text", note: "nota" })
        .pipe(Effect.flip)
      expect(failure).toBeInstanceOf(NotFound)
      expect(failure).toMatchObject({ entity: "Decision", id: "d-missing" })
    }).pipe(Effect.provide(BeaconTest)),
  )

  it.effect('stores a value correction as "-> <valor>" when the value is one of the question options', () =>
    Effect.gen(function* () {
      yield* appendAll(decisionsFor(TASK))
      const outcomes = makeOutcomes(yield* Beacon)
      yield* outcomes.recordTaskOutcomes(TASK, "done")

      expect(yield* outcomes.recordHumanCorrection("d-intent", { kind: "value", value: "research" })).toBe(
        true,
      )

      const latest = yield* outcomesNow
      expect(latest.get("d-intent")).toEqual({
        decisionId: "d-intent",
        outcome: "corrected_by_human",
        note: "-> research",
      })
    }).pipe(Effect.provide(BeaconTest)),
  )

  it.effect("accepts the owner and executor values of the roster and rejects any other", () =>
    Effect.gen(function* () {
      yield* appendAll(decisionsFor(TASK))
      const outcomes = makeOutcomes(yield* Beacon)
      yield* outcomes.recordTaskOutcomes(TASK, "done")

      // decisionMade carries an empty roster: the owner options are only "new".
      expect(yield* outcomes.recordHumanCorrection("d-owner", { kind: "value", value: "new" })).toBe(true)
      const rejected = yield* outcomes
        .recordHumanCorrection("d-executor", { kind: "value", value: "bot_not_in_roster" })
        .pipe(Effect.flip)
      expect(rejected).toBeInstanceOf(SchemaViolation)
      expect(rejected).toMatchObject({ where: "correction.value" })
    }).pipe(Effect.provide(BeaconTest)),
  )

  it.effect("rejects a value outside the options and writes nothing", () =>
    Effect.gen(function* () {
      yield* appendAll(decisionsFor(TASK))
      const outcomes = makeOutcomes(yield* Beacon)
      yield* outcomes.recordTaskOutcomes(TASK, "done")

      const failure = yield* outcomes
        .recordHumanCorrection("d-intent", { kind: "value", value: "writer" })
        .pipe(Effect.flip)
      expect(failure).toBeInstanceOf(SchemaViolation)
      expect(failure).toMatchObject({ where: "correction.value", issue: "writer" })

      const latest = yield* outcomesNow
      expect(latest.get("d-intent")?.outcome).toBe("correct")
    }).pipe(Effect.provide(BeaconTest)),
  )

  it.effect("rejects free text that would read as a value and keeps the decision open", () =>
    Effect.gen(function* () {
      yield* appendAll(decisionsFor(TASK))
      const outcomes = makeOutcomes(yield* Beacon)
      yield* outcomes.recordTaskOutcomes(TASK, "done")

      const failure = yield* outcomes
        .recordHumanCorrection("d-intent", { kind: "text", note: "-> writer" })
        .pipe(Effect.flip)
      expect(failure).toBeInstanceOf(SchemaViolation)
      expect((yield* outcomesNow).get("d-intent")?.outcome).toBe("correct")
    }).pipe(Effect.provide(BeaconTest)),
  )
})

describe("terminal task outcome (lifecycle)", () => {
  it.effect(
    "an ok task closes its decisions as correct (intent, owner, executor) and unknown otherwise",
    () => {
      const tank = makeFakeTank()
      return Effect.gen(function* () {
        const lead = yield* Lead
        const bot = yield* createBot
        const spec = yield* lead.intake(specFor(bot))
        yield* appendAll(decisionsFor(spec.id))
        const verdict = yield* lead.runOnce(spec.id)
        expect(verdict.kind).toBe("ok")

        const latest = yield* outcomesNow
        expect(latest.get("d-intent")?.outcome).toBe("correct")
        expect(latest.get("d-owner")?.outcome).toBe("correct")
        expect(latest.get("d-executor")?.outcome).toBe("correct")
        expect(latest.get("d-complexity")?.outcome).toBe("unknown")
        const all = yield* allEvents
        // Four seeded decisions plus the executor choice the runner records (T-074).
        expect(all.filter((event) => event.type === "decision.outcome")).toHaveLength(5)
      }).pipe(Effect.provide(leadLayer({ executor: fakeExecutor(eventsOf(OK_EVENTS)), tank })))
    },
  )

  it.effect("a task that fails after its retries closes every decision as unknown", () => {
    const tank = makeFakeTank()
    const maxTurns = [
      { kind: "started" as const },
      { kind: "error" as const, code: "max_turns" as const, message: "reached the turn limit" },
    ]
    return Effect.gen(function* () {
      const lead = yield* Lead
      const bot = yield* createBot
      const spec = yield* lead.intake(specFor(bot))
      yield* appendAll(decisionsFor(spec.id))
      const verdict = yield* lead.runOnce(spec.id)
      expect(verdict.kind).toBe("failed")

      const latest = yield* outcomesNow
      for (const [decisionId] of QUESTIONS) {
        expect(latest.get(decisionId)?.outcome).toBe("unknown")
      }
    }).pipe(Effect.provide(leadLayer({ executor: fakeExecutor(eventsOf(maxTurns)), tank })))
  })
})
