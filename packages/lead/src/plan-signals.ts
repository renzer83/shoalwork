import { EventPayloads, type TaskSpec } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import { type PlanSignals, shouldPlan } from "./plan/planner.js"

const DecisionMade = Schema.decodeUnknownOption(EventPayloads["decision.made"])
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// What the Reflex decided about the message behind the task: its last "complexity" and "parallelizable" answers
// (decision.made keyed by the task's correlation id, or by the task id; read through the correlation index, never
// the whole log). Empty when there is none.
export const signalsOf = (sql: SqlClient, spec: TaskSpec): Effect.Effect<PlanSignals, SqlError> =>
  Effect.gen(function* () {
    // The trigger already holds without the Reflex: the lookup is not needed.
    if (shouldPlan(spec)) return {}
    const ids = [spec.id, ...(spec.correlationId === undefined ? [] : [spec.correlationId])]
    const rows = yield* sql<{ readonly payload: string }>`
      SELECT payload FROM events
      WHERE type = 'decision.made' AND correlation_id IN ${sql.in(ids)}
      ORDER BY rowid`
    let signals: { complexity?: number; parallelizable?: boolean } = {}
    for (const row of rows) {
      const decision = DecisionMade(parseJson(row.payload))
      if (decision._tag === "None") continue
      const { questionId, value } = decision.value
      if (questionId === "complexity" && typeof value === "number")
        signals = { ...signals, complexity: value }
      if (questionId === "parallelizable" && typeof value === "boolean") {
        signals = { ...signals, parallelizable: value }
      }
    }
    return signals
  })
