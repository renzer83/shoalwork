import { Data } from "effect"

// Bot API URLs carry the token (/bot<token>/method), and transport errors may echo the URL in their own
// message or in a nested `error`/`cause`. Everything is redacted before it reaches a value, a log or an event.
const BOT_PATH_TOKEN = /bot\d+:[A-Za-z0-9_-]+/g
const BARE_TOKEN = /\b\d{5,}:[A-Za-z0-9_-]{20,}/g
const MAX_MESSAGE = 200
const MAX_DEPTH = 4

export const redact = (text: string): string =>
  text.replace(BOT_PATH_TOKEN, "bot<redacted>").replace(BARE_TOKEN, "<redacted>")

const ownText = (cause: unknown): string => {
  if (cause instanceof Error) {
    return cause.message
  }
  if (typeof cause === "object" && cause !== null && "_tag" in cause && typeof cause._tag === "string") {
    return cause._tag
  }
  return String(cause)
}

const nestedOf = (cause: object): ReadonlyArray<unknown> => {
  const found: Array<unknown> = []
  if ("error" in cause) {
    found.push(cause.error)
  }
  if ("cause" in cause) {
    found.push(cause.cause)
  }
  return found
}

// Redacted, truncated text for an error and everything nested under it. Never includes the raw object.
export const describeError = (cause: unknown, depth = 0): string => {
  const parts = [redact(ownText(cause))]
  if (depth < MAX_DEPTH && typeof cause === "object" && cause !== null) {
    for (const inner of nestedOf(cause)) {
      if (inner !== undefined && inner !== null) {
        parts.push(describeError(inner, depth + 1))
      }
    }
  }
  return parts
    .filter((part) => part.length > 0)
    .join(" | ")
    .slice(0, MAX_MESSAGE)
}

export const tagOf = (cause: unknown): string =>
  typeof cause === "object" && cause !== null && "_tag" in cause && typeof cause._tag === "string"
    ? cause._tag
    : "UnknownError"

export class TelegramError extends Data.TaggedError("TelegramError")<{
  readonly op: string
  readonly message: string
}> {}

export const telegramError =
  (op: string) =>
  (cause: unknown): TelegramError =>
    new TelegramError({ op, message: describeError(cause) })
