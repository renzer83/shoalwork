import { Budget } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"

// The most steps a plan may have (the prompt asks for 3 to 8; this is the hard limit).
export const MAX_STEPS = 12
// Size limits of what a model may write into a plan. They keep a plan (stored, shown, run) small whatever it answers.
export const LIMITS = {
  title: 200,
  prompt: 4000,
  criterion: 300,
  criteria: 20,
  checks: 5,
  argv: 20,
  arg: 200,
  reply: 200_000,
} as const

// What the heavy tier may answer: a Plan without ids. Steps name each other by a local `ref`, Bots by name; the
// Planner turns refs into StepIds and names into BotIds, so a model never invents an id.
export const REF_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
const Ref = Schema.String.check(Schema.isPattern(REF_PATTERN))

// One acceptance command as argv (no shell). The limits keep a model from sending a novel as a command.
export const DraftCheck = Schema.Struct({
  argv: Schema.Array(Schema.String.check(Schema.isMaxLength(LIMITS.arg))).check(
    Schema.isMaxLength(LIMITS.argv),
  ),
})
export type DraftCheck = typeof DraftCheck.Type

export const DraftStep = Schema.Struct({
  ref: Ref,
  title: Schema.String.check(Schema.isMaxLength(LIMITS.title)),
  prompt: Schema.String.check(Schema.isMaxLength(LIMITS.prompt)),
  dependsOn: Schema.Array(Ref).check(Schema.isMaxLength(MAX_STEPS)),
  acceptance: Schema.Array(Schema.String.check(Schema.isMaxLength(LIMITS.criterion))).check(
    Schema.isMaxLength(LIMITS.criteria),
  ),
  // A reply with no "checks" key means no commands.
  checks: Schema.Array(DraftCheck)
    .check(Schema.isMaxLength(LIMITS.checks))
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  budget: Budget,
  tier: Schema.Literals(["light", "heavy"]),
  parallelizable: Schema.Boolean,
  // A Bot name from the list given in the prompt, or "new" when no Bot fits.
  assignedBot: Schema.String,
})
export type DraftStep = typeof DraftStep.Type

export const PlanDraft = Schema.Struct({ steps: Schema.Array(DraftStep) })
export type PlanDraft = typeof PlanDraft.Type

export const decodePlanDraft = Schema.decodeUnknownOption(Schema.fromJsonString(PlanDraft))

// JSON Schema (draft 2020-12) of PlanDraft, derived from the Schema above. Goes in the prompt; a CLI that takes
// `--json-schema` can use the same document.
export const planJsonSchema = Schema.toJsonSchemaDocument(PlanDraft)
