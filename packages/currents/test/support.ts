import { BeaconLive } from "@shoalwork/beacon"
import { BotRegistryLive } from "@shoalwork/bots"
import { NewBot } from "@shoalwork/contracts"
import { withTempDb } from "@shoalwork/db/testing"
import { Layer, Schema } from "effect"
import type { UserFromGetMe } from "grammy/types"
import type { SendOptions, TelegramApi } from "../src/telegram/topics.js"

// Real SQLite per test (fresh file, migrations applied), with the Beacon and the BotRegistry on top.
export const TestLayer = Layer.provideMerge(BotRegistryLive, Layer.provideMerge(BeaconLive, withTempDb()))

// Fake token: only the shape matters for redaction tests. No request ever leaves the process.
export const TOKEN = "42:fake-token"
export const FORUM_CHAT = "-1001234567"
export const ALLOWED_USER = 42
export const STRANGER = 999

export const BOT_INFO: UserFromGetMe = {
  id: 42,
  is_bot: true,
  first_name: "shoal-test",
  username: "shoal_test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: true,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
}

const baseBot = {
  role: "test",
  instructions: "test bot",
  kind: "fixed",
  executors: { preferred: "claude-code", allowed: ["claude-code"] },
  modelTiers: {},
  connectors: [],
  budget: { tokens: 1000, seconds: 60, usd: 1 },
  policy: "default",
  tank: { mode: "local", host: "test" },
  memory: { scope: "global" },
}

export const LEAD_DEF = Schema.decodeUnknownSync(NewBot)({ ...baseBot, name: "lead" })
export const DEV_DEF = Schema.decodeUnknownSync(NewBot)({ ...baseBot, name: "dev" })

export interface SentMessage {
  readonly chatId: string
  readonly text: string
  readonly other: SendOptions
}

export interface FakeTelegram {
  readonly api: TelegramApi
  readonly sent: Array<SentMessage>
  readonly topicsCreated: Array<{ readonly chatId: string; readonly name: string }>
  readonly chatActions: Array<{ readonly chatId: string; readonly threadId: number }>
  readonly edits: Array<{ readonly chatId: string; readonly messageId: number; readonly other: unknown }>
}

// Stands in for the grammY Api: records calls, never touches the network.
export const makeFakeTelegram = (
  options: { readonly failSendMessage?: Error; readonly failChatAction?: boolean } = {},
): FakeTelegram => {
  const sent: Array<SentMessage> = []
  const topicsCreated: Array<{ chatId: string; name: string }> = []
  const chatActions: Array<{ chatId: string; threadId: number }> = []
  const edits: FakeTelegram["edits"] = []
  let nextThreadId = 100 // first topic gets 101
  const api: TelegramApi = {
    sendMessage: (chatId, text, other) => {
      if (options.failSendMessage !== undefined) {
        return Promise.reject(options.failSendMessage)
      }
      sent.push({ chatId, text, other })
      return Promise.resolve({ message_id: sent.length })
    },
    editMessageReplyMarkup: (chatId, messageId, other) => {
      edits.push({ chatId, messageId, other })
      return Promise.resolve(true)
    },
    sendChatAction: (chatId, _action, other) => {
      if (options.failChatAction === true) {
        return Promise.reject(new Error("chat action refused"))
      }
      chatActions.push({ chatId, threadId: other.message_thread_id })
      return Promise.resolve(true)
    },
    createForumTopic: (chatId, name) => {
      topicsCreated.push({ chatId, name })
      nextThreadId += 1
      return Promise.resolve({ message_thread_id: nextThreadId })
    },
  }
  return { api, sent, topicsCreated, chatActions, edits }
}
