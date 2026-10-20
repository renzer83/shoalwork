import { Schema } from "effect"
import { BotId, TaskId, TideId } from "../ids.js"

// A firing that made a task: cron window, event, webhook (event) or the manual run of the API.
export const TideFiredPayload = Schema.Struct({
  tideId: TideId,
  botId: BotId,
  trigger: Schema.Literals(["cron", "event", "manual"]),
  taskId: TaskId,
})

// A Tide held back without a task. Reasons: cooldown (inside its window), cap (hourly maximum), disabled (a firing
// asked of a Tide that is off), feedback (an event the Tides write themselves, or the Bot's own work, not opted in).
export const TideSkippedPayload = Schema.Struct({
  tideId: TideId,
  botId: BotId,
  reason: Schema.Literals(["cooldown", "cap", "disabled", "feedback"]),
})
