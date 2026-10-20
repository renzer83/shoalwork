import { it } from "@effect/vitest"
import { Beacon } from "@shoalwork/beacon"
import { BotRegistry } from "@shoalwork/bots"
import { streamIds } from "@shoalwork/contracts"
import { Effect, Stream } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import { Api } from "grammy"
import type { Update } from "grammy/types"
import { afterEach, describe, expect, vi } from "vitest"
import { createTelegramBot, installInbound } from "../../src/telegram/bot.js"
import {
  botProposalButtons,
  installCallbacks,
  memoryButtons,
  memoryCallbackText,
  proposalCallbackText,
} from "../../src/telegram/callbacks.js"
import { ALLOWED_USER, BOT_INFO, FORUM_CHAT, LEAD_DEF, STRANGER, TestLayer, TOKEN } from "../support.js"

const PROPOSAL = "prop_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
const GROUP_CHAT = -1009999999

const callbackUpdate = (fields: {
  readonly from: number
  readonly data: string
  readonly chatId?: number
}): Update => ({
  update_id: 2,
  callback_query: {
    id: "cb-1",
    chat_instance: "ci-1",
    from: { id: fields.from, is_bot: false, first_name: "Renan" },
    data: fields.data,
    message: {
      message_id: 7,
      date: 1_800_000_000,
      chat: { id: fields.chatId ?? Number(FORUM_CHAT), type: "supergroup", title: "shoal", is_forum: true },
      text: "Proposta de Bot",
    },
  },
})

const inboundEvents = Effect.gen(function* () {
  const beacon = yield* Beacon
  return Array.from(yield* Stream.runCollect(beacon.readAll(0, ["message.inbound"])))
})

describe("proposalCallbackText", () => {
  it("turns a confirm press into the confirm-bot command", () => {
    expect(proposalCallbackText(`botprop:ok:${PROPOSAL}`)).toBe(`/confirm-bot ${PROPOSAL} ok`)
  })

  it("turns a cancel press into the confirm-bot command with no", () => {
    expect(proposalCallbackText(`botprop:no:${PROPOSAL}`)).toBe(`/confirm-bot ${PROPOSAL} no`)
  })

  it("ignores any other callback data", () => {
    expect(proposalCallbackText(`botprop:maybe:${PROPOSAL}`)).toBeUndefined()
    expect(proposalCallbackText(`botprop:ok:not-an-id`)).toBeUndefined()
    expect(proposalCallbackText(`approve:${PROPOSAL}`)).toBeUndefined()
    expect(proposalCallbackText(`botprop:ok:${PROPOSAL} extra`)).toBeUndefined()
  })
})

describe("botProposalButtons", () => {
  it("builds one row with Confirmar and Cancelar carrying the proposal id", () => {
    const [row] = botProposalButtons(PROPOSAL).inline_keyboard
    expect(row?.map((button) => ("callback_data" in button ? button.callback_data : undefined))).toEqual([
      `botprop:ok:${PROPOSAL}`,
      `botprop:no:${PROPOSAL}`,
    ])
  })
})

const MEMORY = "mem_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"

describe("memoryCallbackText", () => {
  it("turns a forget or cancel press into the memory command", () => {
    expect(memoryCallbackText(`mem:forget:${MEMORY}`)).toBe(`/memory mem:forget:${MEMORY}`)
    expect(memoryCallbackText("mem:cancel")).toBe("/memory mem:cancel")
  })

  it("ignores any other callback data", () => {
    expect(memoryCallbackText("mem:forget:not-an-id")).toBeUndefined()
    expect(memoryCallbackText(`mem:forget:${MEMORY} extra`)).toBeUndefined()
    expect(memoryCallbackText(`botprop:ok:${PROPOSAL}`)).toBeUndefined()
  })
})

describe("memoryButtons", () => {
  it("builds one row with a button per entry", () => {
    const [row] = memoryButtons([
      { label: "1", data: `mem:forget:${MEMORY}` },
      { label: "cancelar", data: "mem:cancel" },
    ]).inline_keyboard
    expect(row?.map((button) => ("text" in button ? button.text : undefined))).toEqual(["1", "cancelar"])
    expect(row?.map((button) => ("callback_data" in button ? button.callback_data : undefined))).toEqual([
      `mem:forget:${MEMORY}`,
      "mem:cancel",
    ])
  })
})

// Real grammY Bot; the Api is intercepted so answerCallbackQuery never reaches the network.
const setup = () =>
  Effect.gen(function* () {
    const registry = yield* BotRegistry
    yield* registry.upsert(LEAD_DEF, "test")
    // handleUpdate builds its own Api per update, so the stub goes on the class: no call reaches the network.
    vi.spyOn(Api.prototype, "answerCallbackQuery").mockResolvedValue(true)
    const bot = createTelegramBot(TOKEN, { botInfo: BOT_INFO })
    const context = yield* Effect.context<Beacon | BotRegistry | SqlClient>()
    const inbound = {
      allowedUserIds: new Set([ALLOWED_USER]),
      forumChatId: FORUM_CHAT,
      context,
    }
    installInbound(bot, inbound)
    installCallbacks(bot, inbound)
    return { bot }
  })

describe("installCallbacks", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.effect("records one message.inbound with the confirm-bot text for an allowlisted press", () =>
    Effect.gen(function* () {
      const { bot } = yield* setup()
      yield* Effect.promise(() =>
        bot.handleUpdate(callbackUpdate({ from: ALLOWED_USER, data: `botprop:ok:${PROPOSAL}` })),
      )
      const events = yield* inboundEvents
      expect(events).toHaveLength(1)
      expect(events[0]?.streamId).toBe(streamIds.bot(yield* leadIdOf()))
      expect(events[0]?.payload).toMatchObject({
        channel: "telegram",
        userId: String(ALLOWED_USER),
        text: `/confirm-bot ${PROPOSAL} ok`,
      })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("records the memory command for a forget press and takes the keyboard off the message", () =>
    Effect.gen(function* () {
      const { bot } = yield* setup()
      const edit = vi.spyOn(Api.prototype, "editMessageReplyMarkup").mockResolvedValue(true)
      yield* Effect.promise(() =>
        bot.handleUpdate(callbackUpdate({ from: ALLOWED_USER, data: `mem:forget:${MEMORY}` })),
      )
      const events = yield* inboundEvents
      expect(events).toHaveLength(1)
      expect(events[0]?.payload).toMatchObject({ text: `/memory mem:forget:${MEMORY}` })
      expect(edit).toHaveBeenCalledTimes(1)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("drops a press from a user outside the allowlist without an event", () =>
    Effect.gen(function* () {
      const { bot } = yield* setup()
      yield* Effect.promise(() =>
        bot.handleUpdate(callbackUpdate({ from: STRANGER, data: `botprop:ok:${PROPOSAL}` })),
      )
      expect(yield* inboundEvents).toHaveLength(0)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("drops a press from another group chat without an event", () =>
    Effect.gen(function* () {
      const { bot } = yield* setup()
      yield* Effect.promise(() =>
        bot.handleUpdate(
          callbackUpdate({ from: ALLOWED_USER, data: `botprop:ok:${PROPOSAL}`, chatId: GROUP_CHAT }),
        ),
      )
      expect(yield* inboundEvents).toHaveLength(0)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("ignores callback data that is not a proposal button", () =>
    Effect.gen(function* () {
      const { bot } = yield* setup()
      yield* Effect.promise(() => bot.handleUpdate(callbackUpdate({ from: ALLOWED_USER, data: "approve:x" })))
      expect(yield* inboundEvents).toHaveLength(0)
    }).pipe(Effect.provide(TestLayer)),
  )
})

const leadIdOf = () =>
  Effect.gen(function* () {
    const registry = yield* BotRegistry
    return (yield* registry.getByName("lead")).id
  })
