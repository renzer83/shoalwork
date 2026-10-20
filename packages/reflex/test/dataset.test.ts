import { it } from "@effect/vitest"
import { Beacon, BeaconTest } from "@shoalwork/beacon"
import { streamIds } from "@shoalwork/contracts"
import { Effect, Layer, Stream } from "effect"
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
      const line = toNdjsonLine(row)
      expect(line).not.toContain("userId")
      expect(line).not.toContain("987654321")
      expect(line).not.toContain("correlationId")
    }).pipe(Effect.provide(TestLayer)),
  )

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
      facts: { text: "oi", channel: "api", hasRepo: false, bots: [], executors: [] },
      question: { id: "intent", kind: "choice" },
      answer: { value: "chat", confidence: 0.6, source: "rule" },
      outcome: "unknown",
    })
    expect(line.endsWith("\n")).toBe(true)
    expect(line.split("\n")).toHaveLength(2)
    expect(JSON.parse(line)).toMatchObject({ decisionId: "evt_1", outcome: "unknown" })
  })
})
