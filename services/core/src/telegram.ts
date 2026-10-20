import { ConfigError } from "@shoalwork/contracts"
import { TelegramError, TelegramLive, TelegramOut, type TelegramOutShape } from "@shoalwork/currents"
import { Cause, Context, Effect, Layer, Option, Redacted } from "effect"
import type { AppConfigShape } from "./config.js"

// Whether the Telegram connector is running. The conversation starts only when it is.
export class TelegramStatus extends Context.Service<TelegramStatus, { readonly enabled: boolean }>()(
  "@shoalwork/TelegramStatus",
) {}

export interface TelegramSettings {
  readonly token: Redacted.Redacted<string>
  readonly allowedUserIds: ReadonlyArray<number>
  readonly forumChatId: string
}

const USER_ID = /^\d+$/

// Pure: the connector's settings from the env, or undefined when no token is set (Telegram stays off).
// A token with an incomplete setup is a ConfigError: starting without an allowlist would accept nobody.
export const telegramSettings = (
  config: Pick<AppConfigShape, "telegramBotToken" | "telegramAllowedUserIds" | "telegramForumChatId">,
): Effect.Effect<TelegramSettings | undefined, ConfigError> =>
  Effect.gen(function* () {
    const token = Option.filter(config.telegramBotToken, (value) => Redacted.value(value).trim() !== "")
    if (Option.isNone(token)) {
      return undefined
    }
    const parts = config.telegramAllowedUserIds
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "")
    if (parts.length === 0 || !parts.every((part) => USER_ID.test(part))) {
      return yield* Effect.fail(
        new ConfigError({
          key: "TELEGRAM_ALLOWED_USER_IDS",
          message: "comma-separated numeric Telegram user ids are required when TELEGRAM_BOT_TOKEN is set",
        }),
      )
    }
    const forumChatId = config.telegramForumChatId.trim()
    if (forumChatId === "") {
      return yield* Effect.fail(
        new ConfigError({
          key: "TELEGRAM_FORUM_CHAT_ID",
          message: "required when TELEGRAM_BOT_TOKEN is set",
        }),
      )
    }
    return { token: token.value, allowedUserIds: parts.map(Number), forumChatId }
  })

const disabledError = new TelegramError({ op: "disabled", message: "telegram is not running" })

const DISABLED_OUT: TelegramOutShape = {
  send: () => Effect.fail(disabledError),
  sendRef: () => Effect.fail(disabledError),
  editReplyMarkup: () => Effect.fail(disabledError),
  typing: () => Effect.void,
  ensureTopic: () => Effect.fail(disabledError),
}

const Disabled = Layer.mergeAll(
  Layer.succeed(TelegramOut, DISABLED_OUT),
  Layer.succeed(TelegramStatus, { enabled: false }),
)

const Enabled = (settings: TelegramSettings) =>
  Layer.mergeAll(TelegramLive(settings), Layer.succeed(TelegramStatus, { enabled: true }))

// The connector when configured; otherwise (or when it fails to start) a no-op, so the core always boots.
export const TelegramFromSettings = (settings: TelegramSettings | undefined) => {
  if (settings === undefined) {
    return Layer.merge(
      Layer.effectDiscard(Effect.logInfo("telegram disabled: TELEGRAM_BOT_TOKEN is not set")),
      Disabled,
    )
  }
  return Layer.catchCause(Enabled(settings), (cause) => {
    const error = Cause.squash(cause)
    const detail = error instanceof TelegramError ? error.message : "unexpected failure"
    return Layer.merge(
      Layer.effectDiscard(Effect.logError(`telegram disabled: it did not start (${detail})`)),
      Disabled,
    )
  })
}
