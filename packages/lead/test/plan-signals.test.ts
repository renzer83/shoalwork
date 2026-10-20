import { it } from "@effect/vitest"
import { Beacon } from "@shoalwork/beacon"
import { newTaskId, streamIds, type TaskSpec } from "@shoalwork/contracts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { signalsOf } from "../src/plan-signals.js"
import { PodLayer } from "./pods-support.js"
import { createBot, specFor } from "./support.js"

const decision = (questionId: string, value: number | boolean, correlationId: string) => ({
  streamId: streamIds.system,
  type: "decision.made" as const,
  payload: {
    decisionId: `d-${questionId}-${correlationId}-${String(value)}`,
    questionId,
    kind: typeof value === "number" ? ("score" as const) : ("noul" as const),
    value,
    confidence: 0.9,
    source: "rule" as const,
    facts: {},
  },
  actor: "reflex",
  correlationId,
})

describe("signalsOf", () => {
  it.effect("reads the last complexity and parallelizable answers of the task's own message", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const beacon = yield* Beacon
      const bot = yield* createBot
      const message = "msg-1"
      const spec: TaskSpec = {
        ...specFor(bot, { kind: "research", acceptance: ["one"], correlationId: message }),
        id: newTaskId(),
      }
      yield* beacon.append(decision("complexity", 1, message))
      yield* beacon.append(decision("complexity", 4, message))
      yield* beacon.append(decision("parallelizable", true, message))
      // Another message's decisions never count.
      yield* beacon.append(decision("complexity", 0, "msg-2"))
      expect(yield* signalsOf(sql, spec)).toEqual({ complexity: 4, parallelizable: true })
      expect(yield* signalsOf(sql, { ...spec, correlationId: "msg-3" })).toEqual({})
    }).pipe(Effect.provide(PodLayer)),
  )

  it.effect("needs no lookup when the trigger already holds", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const bot = yield* createBot
      const spec: TaskSpec = {
        ...specFor(bot, { kind: "code", acceptance: ["a", "b", "c"] }),
        id: newTaskId(),
      }
      expect(yield* signalsOf(sql, spec)).toEqual({})
    }).pipe(Effect.provide(PodLayer)),
  )
})
