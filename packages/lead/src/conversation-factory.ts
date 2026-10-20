import type { BeaconShape } from "@shoalwork/beacon"
import { type Bot, type BotId, type Event, streamIds } from "@shoalwork/contracts"
import { Effect } from "effect"
import {
  type BotFactoryDeps,
  type ConfirmOutcome,
  handleConfirmBot,
  isCreateBotRequest,
  parseConfirmBot,
  proposeBot,
} from "./bot-factory.js"

const RESOLVED: Partial<Record<ConfirmOutcome["kind"], "confirmed" | "rejected" | "expired" | "failed">> = {
  created: "confirmed",
  cancelled: "rejected",
  expired: "expired",
  failed: "failed",
}

// Creating Bots by conversation, decided before the Reflex: a confirmation is not a chat message. Every proposal and
// every decision on one becomes an event (ids and names only). Resolves true when the message was handled here.
export const makeFactoryStep =
  (beacon: BeaconShape, deps: BotFactoryDeps) =>
  (event: Event, topicBot: Bot, text: string, userId: string): Effect.Effect<boolean, unknown> => {
    const by = `user:telegram:${userId}`
    const record = (botId: BotId, type: "bot.proposed" | "bot.proposal_resolved", payload: unknown) =>
      beacon
        .append({
          streamId: streamIds.bot(botId),
          type,
          payload,
          actor: by,
          correlationId: event.correlationId,
        })
        .pipe(Effect.catchCause(() => Effect.logWarning("bot factory event not recorded", type)))

    return Effect.gen(function* () {
      const decision = parseConfirmBot(text)
      if (decision !== undefined) {
        const outcome = yield* handleConfirmBot(deps, { replyTo: topicBot.id, ...decision, userId })
        const status = RESOLVED[outcome.kind]
        if (status !== undefined && outcome.proposalId !== undefined && outcome.botName !== undefined) {
          yield* record(topicBot.id, "bot.proposal_resolved", {
            proposalId: outcome.proposalId,
            botName: outcome.botName,
            status,
          })
        }
        return true
      }
      if (isCreateBotRequest(text)) {
        const outcome = yield* proposeBot(deps, { botId: topicBot.id, requestedBy: userId, text })
        if (outcome.kind === "proposed") {
          yield* record(topicBot.id, "bot.proposed", {
            proposalId: outcome.proposalId,
            botName: outcome.botName,
            requestedBy: userId,
          })
        }
        return true
      }
      return false
    })
  }
