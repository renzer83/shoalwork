import { it } from "@effect/vitest"
import type { Beacon } from "@shoalwork/beacon"
import { BotRegistry } from "@shoalwork/bots"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import { Api } from "grammy"
import type { Update } from "grammy/types"
import { afterEach, describe, expect, vi } from "vitest"
import {
  type ApprovalAnswer,
  type ApprovalPort,
  approvalButtons,
  parseApprovalCallback,
} from "../../src/telegram/approvals.js"
import { createTelegramBot, installInbound } from "../../src/telegram/bot.js"
import { installCallbacks } from "../../src/telegram/callbacks.js"
import { ALLOWED_USER, BOT_INFO, FORUM_CHAT, LEAD_DEF, STRANGER, TestLayer, TOKEN } from "../support.js"

const APPROVAL = "apr_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"

const press = (from: number, data: string, chatId = Number(FORUM_CHAT)): Update => ({
  update_id: 3,
  callback_query: {
    id: "cb-2",
    chat_instance: "ci-1",
    from: { id: from, is_bot: false, first_name: "Renan" },
    data,
    message: {
      message_id: 9,
      date: 1_800_000_000,
      chat: { id: chatId, type: "supergroup", title: "shoal", is_forum: true },
      text: "Aprovação",
    },
  },
})

describe("approval callback data", () => {
  it("builds apr:ok and apr:no buttons carrying the approval id", () => {
    const [row] = approvalButtons(APPROVAL).inline_keyboard
    expect(row?.map((button) => ("callback_data" in button ? button.callback_data : undefined))).toEqual([
      `apr:ok:${APPROVAL}`,
      `apr:no:${APPROVAL}`,
    ])
  })

  it("parses only the fixed format", () => {
    expect(parseApprovalCallback(`apr:ok:${APPROVAL}`)).toEqual({ id: APPROVAL, decision: "approved" })
    expect(parseApprovalCallback(`apr:no:${APPROVAL}`)).toEqual({ id: APPROVAL, decision: "denied" })
    expect(parseApprovalCallback(`apr:ok:${APPROVAL} extra`)).toBeUndefined()
    expect(parseApprovalCallback("apr:ok:short")).toBeUndefined()
    expect(parseApprovalCallback(`apr:maybe:${APPROVAL}`)).toBeUndefined()
    expect(parseApprovalCallback(`approve:${APPROVAL}`)).toBeUndefined()
  })
})

const setup = (answer: ApprovalAnswer) =>
  Effect.gen(function* () {
    const registry = yield* BotRegistry
    yield* registry.upsert(LEAD_DEF, "test")
    const answered = vi.spyOn(Api.prototype, "answerCallbackQuery").mockResolvedValue(true)
    const edit = vi.spyOn(Api.prototype, "editMessageReplyMarkup").mockResolvedValue(true)
    const calls: Array<readonly [string, string, string]> = []
    const approvals: ApprovalPort = {
      decide: (id, decision, by) =>
        Effect.sync(() => {
          calls.push([id, decision, by])
          return answer
        }),
    }
    const bot = createTelegramBot(TOKEN, { botInfo: BOT_INFO })
    const context = yield* Effect.context<Beacon | BotRegistry | SqlClient>()
    const inbound = { allowedUserIds: new Set([ALLOWED_USER]), forumChatId: FORUM_CHAT, context, approvals }
    installInbound(bot, inbound)
    installCallbacks(bot, inbound)
    return { bot, calls, answered, edit }
  })

describe("approval button presses", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.effect("decides once as the pressing user and takes the buttons off", () =>
    Effect.gen(function* () {
      const { bot, calls, edit, answered } = yield* setup("resolved")
      yield* Effect.promise(() => bot.handleUpdate(press(ALLOWED_USER, `apr:ok:${APPROVAL}`)))
      expect(calls).toEqual([[APPROVAL, "approved", `user:telegram:${ALLOWED_USER}`]])
      expect(edit).toHaveBeenCalledTimes(1)
      expect(answered).toHaveBeenCalledTimes(1)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a press on an already decided approval still clears the buttons", () =>
    Effect.gen(function* () {
      const { bot, edit } = yield* setup("already")
      yield* Effect.promise(() => bot.handleUpdate(press(ALLOWED_USER, `apr:no:${APPROVAL}`)))
      expect(edit).toHaveBeenCalledTimes(1)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a failed decision keeps the buttons so the press can be repeated", () =>
    Effect.gen(function* () {
      const { bot, edit, answered } = yield* setup("failed")
      yield* Effect.promise(() => bot.handleUpdate(press(ALLOWED_USER, `apr:ok:${APPROVAL}`)))
      expect(edit).not.toHaveBeenCalled()
      expect(answered).toHaveBeenCalledTimes(1)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("drops a press from a stranger or from another chat without deciding", () =>
    Effect.gen(function* () {
      const { bot, calls } = yield* setup("resolved")
      yield* Effect.promise(() => bot.handleUpdate(press(STRANGER, `apr:ok:${APPROVAL}`)))
      yield* Effect.promise(() => bot.handleUpdate(press(ALLOWED_USER, `apr:ok:${APPROVAL}`, -1009999999)))
      expect(calls).toEqual([])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("ignores malformed data and never reaches the approvals", () =>
    Effect.gen(function* () {
      const { bot, calls } = yield* setup("resolved")
      yield* Effect.promise(() => bot.handleUpdate(press(ALLOWED_USER, "apr:ok:../../etc")))
      expect(calls).toEqual([])
    }).pipe(Effect.provide(TestLayer)),
  )
})
