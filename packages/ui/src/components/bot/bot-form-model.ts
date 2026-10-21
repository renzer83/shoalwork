import { type NewBot, NewBot as NewBotSchema } from "@shoalwork/contracts"
import { Effect, Schema, SchemaIssue } from "effect"

// The form works on text, as inputs do. Validation is the NewBot schema itself, the same one the core decodes with.
export interface BotDraft {
  readonly name: string
  readonly role: string
  readonly instructions: string
  readonly kind: string
  readonly preferred: string
  readonly allowed: string
  readonly connectors: string
  readonly tokens: string
  readonly seconds: string
  readonly usd: string
  readonly policy: string
  readonly tankMode: string
  readonly tankHost: string
  readonly memoryScope: string
}

// Each field: the draft key, the label, and the schema path its errors come back under ("executors.preferred").
export const FIELDS = [
  { key: "name", path: "name", label: "Name" },
  { key: "role", path: "role", label: "Role" },
  { key: "instructions", path: "instructions", label: "Instructions", multiline: true },
  { key: "kind", path: "kind", label: "Kind (fixed | auxiliary)" },
  { key: "preferred", path: "executors.preferred", label: "Preferred executor" },
  { key: "allowed", path: "executors.allowed", label: "Allowed executors (comma separated)" },
  { key: "connectors", path: "connectors", label: "Connectors (comma separated)" },
  { key: "tokens", path: "budget.tokens", label: "Budget tokens" },
  { key: "seconds", path: "budget.seconds", label: "Budget seconds" },
  { key: "usd", path: "budget.usd", label: "Budget USD" },
  { key: "policy", path: "policy", label: "Policy" },
  { key: "tankMode", path: "tank.mode", label: "Tank mode (local | server)" },
  { key: "tankHost", path: "tank.host", label: "Tank host" },
  { key: "memoryScope", path: "memory.scope", label: "Memory scope (bot | pod | global)" },
] as const

export type FieldKey = (typeof FIELDS)[number]["key"]

export type FieldErrors = Readonly<Partial<Record<FieldKey | "form", string>>>

// A new Bot starts from these; the schema decides what is valid on submit.
export const EMPTY_DRAFT: BotDraft = {
  name: "",
  role: "",
  instructions: "",
  kind: "auxiliary",
  preferred: "claude-code",
  allowed: "claude-code",
  connectors: "",
  tokens: "300000",
  seconds: "900",
  usd: "3",
  policy: "default",
  tankMode: "local",
  tankHost: "localhost",
  memoryScope: "bot",
}

export const draftOf = (bot: NewBot): BotDraft => ({
  name: bot.name,
  role: bot.role,
  instructions: bot.instructions,
  kind: bot.kind,
  preferred: bot.executors.preferred,
  allowed: bot.executors.allowed.join(", "),
  connectors: bot.connectors.join(", "),
  tokens: String(bot.budget.tokens),
  seconds: String(bot.budget.seconds),
  usd: String(bot.budget.usd),
  policy: bot.policy,
  tankMode: bot.tank.mode,
  tankHost: bot.tank.host,
  memoryScope: bot.memory.scope,
})

const splitList = (text: string): ReadonlyArray<string> =>
  text
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "")

// An empty number stays text so the schema rejects it; typed text becomes a number, NaN included (the schema refuses it).
const numberOrText = (text: string): number | string => (text.trim() === "" ? text : Number(text))

// The raw input the schema decodes. Not validated here: the schema is the single rule set.
export const draftToInput = (draft: BotDraft): unknown => ({
  name: draft.name.trim(),
  role: draft.role.trim(),
  instructions: draft.instructions,
  kind: draft.kind.trim(),
  executors: { preferred: draft.preferred.trim(), allowed: splitList(draft.allowed) },
  modelTiers: {},
  connectors: splitList(draft.connectors),
  budget: {
    tokens: numberOrText(draft.tokens),
    seconds: numberOrText(draft.seconds),
    usd: numberOrText(draft.usd),
  },
  policy: draft.policy.trim(),
  tank: { mode: draft.tankMode.trim(), host: draft.tankHost.trim() },
  memory: { scope: draft.memoryScope.trim() },
})

const keyForPath = (path: string): FieldKey | "form" => {
  const field = FIELDS.find((candidate) => candidate.path === path)
  return field === undefined ? "form" : field.key
}

export type ValidationResult =
  | { readonly ok: true; readonly bot: NewBot }
  | { readonly ok: false; readonly errors: FieldErrors }

// Decodes the draft with NewBot. Each failing schema issue lands on the field its path names; the first one wins.
export const validateDraft = (draft: BotDraft): ValidationResult => {
  const result = Effect.runSync(Effect.result(Schema.decodeUnknownEffect(NewBotSchema)(draftToInput(draft))))
  if (result._tag === "Success") {
    return { ok: true, bot: result.success }
  }
  const formatted = SchemaIssue.makeFormatterStandardSchemaV1()(result.failure.issue).issues
  const errors: Partial<Record<FieldKey | "form", string>> = {}
  for (const issue of formatted) {
    const path = (issue.path ?? []).map((segment) => String(segment)).join(".")
    const key = keyForPath(path)
    if (errors[key] === undefined) {
      errors[key] = issue.message
    }
  }
  return { ok: false, errors }
}
