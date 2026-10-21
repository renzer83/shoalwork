import { it } from "@effect/vitest"
import { Beacon, type BeaconShape, BeaconTest } from "@shoalwork/beacon"
import { Event, newEventId, streamIds } from "@shoalwork/contracts"
import { DateTime, Effect, Layer, Schema, Stream } from "effect"
import { describe, expect } from "vitest"
import type { Question } from "../src/contract.js"
import { DATASET_TEXT_MAX, type DatasetRow, exportDataset, toNdjsonLine } from "../src/dataset.js"
import { makeReflexLive, Reflex } from "../src/reflex.js"
import { config, factsFor } from "./support.js"

const TestLayer = Layer.provideMerge(makeReflexLive(config), BeaconTest)
const CORRELATION = "corr-dataset-1"

const INTENT: Question = {
  id: "intent",
  kind: "choice",
  options: ["chat", "system", "code", "research", "app_op", "routine"],
}
const OWNER: Question = { id: "owner", kind: "choice", options: [] }

const appendOutcome = (
  decisionId: string,
  outcome: "correct" | "unknown" | "corrected_by_human",
  note?: string,
) =>
  Effect.gen(function* () {
    const beacon = yield* Beacon
    yield* beacon.append({
      streamId: streamIds.system,
      type: "decision.outcome",
      payload: { decisionId, outcome, ...(note === undefined ? {} : { note }) },
      actor: "system:lead",
      correlationId: CORRELATION,
    })
  })

const collectRows = Effect.gen(function* () {
  const beacon = yield* Beacon
  return Array.from(yield* Stream.runCollect(exportDataset(beacon)))
})

// The one row of an export that must hold exactly one line.
const onlyRow = (rows: ReadonlyArray<DatasetRow>): DatasetRow => {
  const [row] = rows
  expect(rows).toHaveLength(1)
  if (row === undefined) {
    throw new Error("expected exactly one dataset row")
  }
  return row
}

// The occurredAt of the only decision.made in the log, in the ISO form the export writes.
const onlyDecisionTs = Effect.gen(function* () {
  const beacon = yield* Beacon
  const events = Array.from(yield* Stream.runCollect(beacon.readAll(0, ["decision.made"])))
  const [event] = events
  expect(events).toHaveLength(1)
  if (event === undefined) {
    throw new Error("expected exactly one decision.made")
  }
  return DateTime.formatIso(event.occurredAt)
})

// A Beacon that serves fixed events and refuses writes: the export only reads the log.
const replayBeacon = (events: ReadonlyArray<Event>): BeaconShape => ({
  append: () => Effect.die(new Error("replay beacon is read-only")),
  appendMany: () => Effect.die(new Error("replay beacon is read-only")),
  readStream: () => Stream.empty,
  readAll: (_after, types) =>
    Stream.fromIterable(events.filter((event) => types === undefined || types.includes(event.type))),
  readRange: () => Stream.empty,
  subscribe: () => Effect.succeed(Stream.empty),
  lastVersion: () => Effect.succeed(0),
})

const storedEvent = (
  position: number,
  occurredAt: string,
  type: string,
  payload: unknown,
  correlationId: string,
): Event =>
  Schema.decodeUnknownSync(Event)({
    id: newEventId(),
    streamId: streamIds.system,
    version: position,
    position,
    type,
    payload,
    actor: "system:reflex",
    correlationId,
    occurredAt,
  })

const decisionPayload = (decisionId: string) => ({
  decisionId,
  questionId: "intent",
  kind: "choice",
  value: "code",
  confidence: 0.9,
  source: "rule",
  facts: { text: "implementa o login", channel: "api", hasRepo: false, bots: [], executors: [] },
})

describe("exportDataset", () => {
  it.effect("joins each decision with its outcome and skips decisions without one", () =>
    Effect.gen(function* () {
      const reflex = yield* Reflex
      const [intent, owner] = yield* reflex.ask(
        factsFor("implementa o login", { correlationId: CORRELATION }),
        [INTENT, OWNER],
      )
      yield* appendOutcome(intent?.decisionId ?? "", "correct")

      const row = onlyRow(yield* collectRows)
      expect(row.decisionId).toBe(intent?.decisionId)
      expect(row).toMatchObject({
        question: { id: "intent", kind: "choice" },
        answer: { value: "code", source: "rule" },
        outcome: "correct",
      })
      expect(owner?.decisionId).not.toBe(row.decisionId)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("keeps the last outcome of a decision and its note", () =>
    Effect.gen(function* () {
      const reflex = yield* Reflex
      const [intent] = yield* reflex.ask(factsFor("implementa o login", { correlationId: CORRELATION }), [
        INTENT,
      ])
      yield* appendOutcome(intent?.decisionId ?? "", "correct")
      yield* appendOutcome(intent?.decisionId ?? "", "corrected_by_human", "era pesquisa")

      expect(onlyRow(yield* collectRows)).toMatchObject({
        outcome: "corrected_by_human",
        note: "era pesquisa",
      })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("drops user identifiers and truncates the text to 500 characters", () =>
    Effect.gen(function* () {
      const reflex = yield* Reflex
      const long = "implementa o login ".repeat(40)
      const [intent] = yield* reflex.ask(
        factsFor(long, { correlationId: CORRELATION, userId: "987654321" }),
        [INTENT],
      )
      yield* appendOutcome(intent?.decisionId ?? "", "unknown")

      const row = onlyRow(yield* collectRows)
      expect(row.facts.text).toBe(long.slice(0, DATASET_TEXT_MAX))
      expect(Object.keys(row.facts)).not.toContain("userId")
      expect(Object.keys(row.facts)).not.toContain("correlationId")
      const line = toNdjsonLine(row)
      expect(line).not.toContain("userId")
      expect(line).not.toContain("987654321")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("exports ts and correlationId, and the value a correction names as corrected", () =>
    Effect.gen(function* () {
      const reflex = yield* Reflex
      const [intent] = yield* reflex.ask(factsFor("implementa o login", { correlationId: CORRELATION }), [
        INTENT,
      ])
      yield* appendOutcome(intent?.decisionId ?? "", "corrected_by_human", "-> research")

      const row = onlyRow(yield* collectRows)
      expect(row).toMatchObject({
        ts: yield* onlyDecisionTs,
        correlationId: CORRELATION,
        note: "-> research",
        corrected: "research",
        outcome: "corrected_by_human",
      })
      expect(JSON.parse(toNdjsonLine(row))).toEqual(row)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a free-text note is exported as the note and never as a corrected value", () =>
    Effect.gen(function* () {
      const reflex = yield* Reflex
      const [intent] = yield* reflex.ask(factsFor("implementa o login", { correlationId: CORRELATION }), [
        INTENT,
      ])
      yield* appendOutcome(intent?.decisionId ?? "", "corrected_by_human", "era pesquisa")

      const row = onlyRow(yield* collectRows)
      expect(row.note).toBe("era pesquisa")
      expect(row).not.toHaveProperty("corrected")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("orders the rows by ts, oldest first, and keeps the log order of equal timestamps", () => {
    const events = [
      storedEvent(1, "2026-10-21T10:00:02.000Z", "decision.made", decisionPayload("d-late"), "corr-late"),
      storedEvent(2, "2026-10-21T10:00:01.000Z", "decision.made", decisionPayload("d-early"), "corr-early"),
      storedEvent(3, "2026-10-21T10:00:01.000Z", "decision.made", decisionPayload("d-tie"), "corr-tie"),
      storedEvent(
        4,
        "2026-10-21T10:00:05.000Z",
        "decision.outcome",
        { decisionId: "d-late", outcome: "correct" },
        "corr-late",
      ),
      storedEvent(
        5,
        "2026-10-21T10:00:05.000Z",
        "decision.outcome",
        { decisionId: "d-early", outcome: "correct" },
        "corr-early",
      ),
      storedEvent(
        6,
        "2026-10-21T10:00:05.000Z",
        "decision.outcome",
        { decisionId: "d-tie", outcome: "correct" },
        "corr-tie",
      ),
    ]
    return Effect.gen(function* () {
      const rows = Array.from(yield* Stream.runCollect(exportDataset(replayBeacon(events))))
      expect(rows.map((row) => row.decisionId)).toEqual(["d-early", "d-tie", "d-late"])
      expect(rows.map((row) => row.ts)).toEqual([
        "2026-10-21T10:00:01.000Z",
        "2026-10-21T10:00:01.000Z",
        "2026-10-21T10:00:02.000Z",
      ])
      expect(rows.map((row) => row.correlationId)).toEqual(["corr-early", "corr-tie", "corr-late"])
    })
  })

  it.effect("exports nothing when no decision has an outcome", () =>
    Effect.gen(function* () {
      const reflex = yield* Reflex
      yield* reflex.ask(factsFor("oi", { correlationId: CORRELATION }))
      expect(yield* collectRows).toEqual([])
    }).pipe(Effect.provide(TestLayer)),
  )
})

describe("toNdjsonLine", () => {
  it("writes one JSON object per line, newline-terminated", () => {
    const line = toNdjsonLine({
      decisionId: "evt_1",
      ts: "2026-10-21T10:00:00.000Z",
      facts: { text: "oi", channel: "api", hasRepo: false, bots: [], executors: [] },
      question: { id: "intent", kind: "choice" },
      answer: { value: "chat", confidence: 0.6, source: "rule" },
      outcome: "unknown",
    })
    expect(line.endsWith("\n")).toBe(true)
    expect(line.split("\n")).toHaveLength(2)
    expect(JSON.parse(line)).toMatchObject({
      decisionId: "evt_1",
      ts: "2026-10-21T10:00:00.000Z",
      outcome: "unknown",
    })
  })
})
