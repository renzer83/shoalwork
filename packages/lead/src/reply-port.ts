import { randomUUID } from "node:crypto"
import type { BeaconShape } from "@shoalwork/beacon"
import { type BotId, type EventId, streamIds, type TaskSpec } from "@shoalwork/contracts"
import type { TelegramOutShape } from "@shoalwork/currents"
import { Clock, Data, Effect } from "effect"

// The channels the conversation answers on. Every other channel (api, cli) has no reply path.
export type ReplyChannel = "telegram" | "app"

export class ReplyFailure extends Data.TaggedError("ReplyFailure")<{
  readonly op: string
  readonly message: string
}> {}

export interface ReplyOptions {
  // The inbound event this reply answers (becomes message.outbound.inReplyTo and the causation id).
  readonly replyTo?: EventId
  // Correlation id of the message or task the reply belongs to; a fresh one when absent.
  readonly correlationId?: string
  // When the inbound event happened (epoch ms), for latencyMs on the Effect clock.
  readonly receivedAtMs?: number
}

// One channel's way out. The Telegram one talks to the connector; the app one only writes to the Beacon.
export interface ChannelOut {
  readonly send: (botId: BotId, text: string, opts?: ReplyOptions) => Effect.Effect<void, ReplyFailure>
  readonly typing: (botId: BotId) => Effect.Effect<void>
}

export interface ReplyPort {
  readonly send: (
    channel: ReplyChannel,
    botId: BotId,
    text: string,
    opts?: ReplyOptions,
  ) => Effect.Effect<void, ReplyFailure>
  readonly typing: (channel: ReplyChannel, botId: BotId) => Effect.Effect<void>
}

export const telegramChannelOut = (telegram: TelegramOutShape): ChannelOut => ({
  send: (botId, text, opts) =>
    telegram
      .send(botId, text, opts?.replyTo === undefined ? {} : { inReplyTo: opts.replyTo })
      .pipe(Effect.mapError((error) => new ReplyFailure({ op: error.op, message: error.message }))),
  typing: (botId) => telegram.typing(botId),
})

// message.outbound{channel:"app"} on the Bot's stream: no network, so a reply cannot be lost on the wire. The
// timeline (GET /messages) and the event feed (SSE) show it like any other outbound.
export const appChannelOut = (beacon: BeaconShape): ChannelOut => ({
  send: (botId, text, opts) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const latencyMs =
        opts?.receivedAtMs === undefined ? undefined : Math.max(0, Math.round(now - opts.receivedAtMs))
      yield* beacon.append({
        streamId: streamIds.bot(botId),
        type: "message.outbound",
        payload: {
          channel: "app",
          botId,
          text,
          ...(latencyMs === undefined ? {} : { latencyMs }),
          ...(opts?.replyTo === undefined ? {} : { inReplyTo: opts.replyTo }),
        },
        actor: `bot:${botId}`,
        correlationId: opts?.correlationId ?? randomUUID(),
        ...(opts?.replyTo === undefined ? {} : { causationId: opts.replyTo }),
      })
    }).pipe(Effect.mapError((error) => new ReplyFailure({ op: "message.outbound", message: error._tag }))),
  // The app shows a typing state from the timeline itself; nothing to emit.
  typing: () => Effect.void,
})

const unavailable = (channel: ReplyChannel) =>
  Effect.fail(new ReplyFailure({ op: "reply", message: `no ${channel} channel is wired` }))

export const makeReplyPort = (outs: Partial<Record<ReplyChannel, ChannelOut>>): ReplyPort => ({
  send: (channel, botId, text, opts) => outs[channel]?.send(botId, text, opts) ?? unavailable(channel),
  typing: (channel, botId) => outs[channel]?.typing(botId) ?? Effect.void,
})

// Who is acting, as the log records it: the Telegram user id, or the app's operator ("user:app").
export const actorFor = (channel: ReplyChannel, userId: string): string =>
  channel === "telegram"
    ? `user:telegram:${userId}`
    : userId.startsWith("user:")
      ? userId
      : `user:app:${userId}`

// The chat a task belongs to: the app for tasks asked there, Telegram for every other origin.
export const channelOfOrigin = (origin: TaskSpec["origin"] | undefined): ReplyChannel =>
  origin === "app" ? "app" : "telegram"

// A message about a task (the Planner's), sent in the task's own chat and under its correlation id.
export const notifyForTask =
  (reply: ReplyPort) => (botId: BotId, text: string, task: Pick<TaskSpec, "origin" | "correlationId">) =>
    reply.send(channelOfOrigin(task.origin), botId, text, {
      ...(task.correlationId === undefined ? {} : { correlationId: task.correlationId }),
    })
