import { it } from "@effect/vitest"
import { Beacon } from "@shoalwork/beacon"
import { newPodId, streamIds } from "@shoalwork/contracts"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { Conversation } from "../src/conversation.js"
import { createBots, harness, settle } from "./conversation-support.js"

describe("conversation and Pods", () => {
  it.effect("leaves a message typed in a Pod's topic to the Pod: no reply, no decision, no task", () => {
    const h = harness()
    return Effect.gen(function* () {
      const { lead } = yield* createBots
      const conversation = yield* Conversation
      const beacon = yield* Beacon
      const event = yield* beacon.append({
        streamId: streamIds.bot(lead.id),
        type: "message.inbound",
        payload: {
          channel: "telegram",
          chatId: "-100",
          threadId: "9",
          userId: "42",
          text: "oi",
          botId: lead.id,
          podId: newPodId(),
        },
        actor: "user:telegram:42",
        correlationId: crypto.randomUUID(),
      })
      yield* conversation.onInbound(event)
      yield* settle
      expect(h.telegram.sent).toEqual([])
      expect(h.chat.runs).toEqual([])
    }).pipe(Effect.provide(h.layer))
  })
})
