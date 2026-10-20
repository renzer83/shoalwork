import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { BotId } from "@shoalwork/contracts"
import { TelegramOut } from "@shoalwork/currents"
import { Conversation } from "@shoalwork/lead"
import { Reef } from "@shoalwork/reef"
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { afterAll, beforeAll, describe, expect } from "vitest"
import { AppLayer } from "../src/runtime.js"
import { TelegramStatus, telegramSettings } from "../src/telegram.js"

const base = {
  telegramBotToken: Option.some(Redacted.make("123:fake")),
  telegramAllowedUserIds: "42, 7",
  telegramForumChatId: "-100123",
}

describe("telegramSettings", () => {
  it.effect("is undefined (Telegram off) when no token is set or the token is blank", () =>
    Effect.gen(function* () {
      expect(yield* telegramSettings({ ...base, telegramBotToken: Option.none() })).toBeUndefined()
      expect(
        yield* telegramSettings({ ...base, telegramBotToken: Option.some(Redacted.make("  ")) }),
      ).toBeUndefined()
    }),
  )

  it.effect("reads the allowlist and the forum chat when the token is set", () =>
    Effect.gen(function* () {
      const settings = yield* telegramSettings(base)
      expect(settings?.allowedUserIds).toEqual([42, 7])
      expect(settings?.forumChatId).toBe("-100123")
      expect(settings === undefined ? "" : Redacted.value(settings.token)).toBe("123:fake")
    }),
  )

  it.effect("fails with a ConfigError naming the key when the setup is incomplete", () =>
    Effect.gen(function* () {
      const noUsers = yield* Effect.flip(telegramSettings({ ...base, telegramAllowedUserIds: "" }))
      expect(noUsers).toMatchObject({ _tag: "ConfigError", key: "TELEGRAM_ALLOWED_USER_IDS" })
      const badUser = yield* Effect.flip(telegramSettings({ ...base, telegramAllowedUserIds: "42,abc" }))
      expect(badUser).toMatchObject({ key: "TELEGRAM_ALLOWED_USER_IDS" })
      const noForum = yield* Effect.flip(telegramSettings({ ...base, telegramForumChatId: " " }))
      expect(noForum).toMatchObject({ key: "TELEGRAM_FORUM_CHAT_ID" })
    }),
  )

  it.effect("never prints the token in a failure", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(telegramSettings({ ...base, telegramAllowedUserIds: "" }))
      expect(JSON.stringify(failure)).not.toContain("123:fake")
    }),
  )
})

// The whole composition with the env of a fresh install: no token, no Ollama running.
describe("AppLayer without Telegram", () => {
  const dir = mkdtempSync(join(tmpdir(), "shoalwork-core-"))
  const saved: Record<string, string | undefined> = {}
  const overrides: Record<string, string> = {
    API_TOKEN: "t",
    DATABASE_PATH: join(dir, "app.db"),
    TANK_ROOT: join(dir, "tank"),
    TELEGRAM_BOT_TOKEN: "",
    OLLAMA_URL: "http://127.0.0.1:1",
  }
  beforeAll(() => {
    for (const [key, value] of Object.entries(overrides)) {
      saved[key] = process.env[key]
      process.env[key] = value
    }
  })
  afterAll(() => {
    for (const key of Object.keys(overrides)) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it.live("builds, with Telegram off and the conversation, Reef and memory hooks provided", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(AppLayer)
      expect(Context.get(context, TelegramStatus).enabled).toBe(false)
      expect(Context.get(context, Conversation).start).toBeDefined()
      expect(Context.get(context, Reef).remember).toBeDefined()
      const botId = Schema.decodeUnknownSync(BotId)("bot_00000000-0000-4000-8000-000000000001")
      const failure = yield* Effect.flip(Context.get(context, TelegramOut).send(botId, "hi"))
      expect(failure.op).toBe("disabled")
    }).pipe(Effect.scoped),
  )
})
