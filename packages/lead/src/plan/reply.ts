import { Effect } from "effect"
import { decodePlanDraft, LIMITS, type PlanDraft } from "./schema-json.js"

// Sentences of ours that go back to the model; the model's own text is never echoed.
export const TOO_LONG = `the reply is longer than ${LIMITS.reply} characters`
export const NOT_A_PLAN = `the reply has no JSON plan with the required fields and limits (title up to ${LIMITS.title} characters, prompt up to ${LIMITS.prompt}, each criterion up to ${LIMITS.criterion}, up to ${LIMITS.criteria} criteria per step)`

// Opening braces tried in one reply: some prose with braces before the plan is fine, a flood of them is not.
const MAX_STARTS = 50

// Where the object that opens at `start` closes, counting braces outside of strings; -1 when it never closes.
const closeOf = (text: string, start: number): number => {
  let depth = 0
  let inString = false
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (char === "\\") index++
      else if (char === '"') inString = false
    } else if (char === '"') inString = true
    else if (char === "{") depth++
    else if (char === "}" && --depth === 0) return index
  }
  return -1
}

// The balanced objects of the reply, by where they open (nested ones too: a stray `{` in the prose must not swallow
// the plan that follows it). A `{` that never closes gives none.
export const jsonObjects = (reply: string): ReadonlyArray<string> => {
  const found: Array<string> = []
  let from = reply.indexOf("{")
  for (let starts = 0; from !== -1 && starts < MAX_STARTS; starts++) {
    const end = closeOf(reply, from)
    if (end !== -1) {
      found.push(reply.slice(from, end + 1))
    }
    from = reply.indexOf("{", from + 1)
  }
  return found
}

// The first object of the reply that is a PlanDraft within the limits.
export const readDraft = (reply: string): Effect.Effect<PlanDraft, ReadonlyArray<string>> => {
  if (reply.length > LIMITS.reply) {
    return Effect.fail([TOO_LONG])
  }
  for (const candidate of jsonObjects(reply)) {
    const draft = decodePlanDraft(candidate)
    if (draft._tag === "Some") {
      return Effect.succeed(draft.value)
    }
  }
  return Effect.fail([NOT_A_PLAN])
}
