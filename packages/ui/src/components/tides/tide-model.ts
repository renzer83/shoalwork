import { Schema } from "effect"

// The run list of one Tide (GET /tides/:id/runs): the firings of the last 30 days, newest first.
export const TideRun = Schema.Struct({
  at: Schema.String,
  taskId: Schema.String,
  trigger: Schema.Literals(["cron", "event", "manual"]),
})
export type TideRun = typeof TideRun.Type
export const TideRunList = Schema.Struct({ runs: Schema.Array(TideRun) })

// Answers of the Tide routes the app calls: the stored Tide, the task a run created, and the enable ack.
export const TideCreated = Schema.Struct({ tide: Schema.Unknown })
export const TideRan = Schema.Struct({ task: Schema.Unknown })
export const TideAck = Schema.Struct({ ok: Schema.Boolean })

export interface TideDraft {
  readonly bot: string
  readonly name: string
  readonly mode: "cron" | "event"
  readonly cronExpr: string
  readonly eventType: string
  readonly title: string
  readonly prompt: string
}

export const EMPTY_TIDE_DRAFT: TideDraft = {
  bot: "",
  name: "",
  mode: "cron",
  cronExpr: "",
  eventType: "",
  title: "",
  prompt: "",
}

// What the form refuses before it sends. The core checks the cron expression itself (400 with the expression named).
export const tideDraftIssues = (draft: TideDraft): ReadonlyArray<string> => {
  const issues: string[] = []
  if (draft.bot.trim() === "") issues.push("Bot: the name of a Bot")
  if (draft.name.trim() === "") issues.push("Name: the Tide's name")
  if (draft.mode === "cron" && draft.cronExpr.trim() === "")
    issues.push("Cron: an expression, e.g. 0 9 * * 1-5")
  if (draft.mode === "event" && draft.eventType.trim() === "")
    issues.push("Event: the event type, e.g. github.issues")
  if (draft.title.trim() === "") issues.push("Title of the task the Tide creates")
  if (draft.prompt.trim() === "") issues.push("Prompt of the task the Tide creates")
  return issues
}

// The body POST /tides takes: a Tide in UTC, enabled, with a routine task template.
export const tideDraftBody = (draft: TideDraft): Record<string, unknown> => ({
  bot: draft.bot.trim(),
  name: draft.name.trim(),
  kind: draft.mode,
  ...(draft.mode === "cron" ? { cronExpr: draft.cronExpr.trim() } : { eventType: draft.eventType.trim() }),
  timezone: "UTC",
  taskTemplate: {
    title: draft.title.trim(),
    prompt: draft.prompt.trim(),
    kind: "routine",
    tier: "light",
    budget: { tokens: 20000, seconds: 300, usd: 0.5 },
  },
  enabled: true,
})

// The schedule of a stored Tide, as a line of text.
export const scheduleText = (tide: {
  readonly kind: "cron" | "event"
  readonly cronExpr?: string | undefined
  readonly eventType?: string | undefined
}): string => (tide.kind === "cron" ? `cron ${tide.cronExpr ?? ""}` : `on ${tide.eventType ?? ""}`)
