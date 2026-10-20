import { it } from "@effect/vitest"
import { Beacon } from "@shoalwork/beacon"
import { BotRegistry } from "@shoalwork/bots"
import { type BotId, newTaskId } from "@shoalwork/contracts"
import { type MessageRef, TelegramError, type TelegramOutShape } from "@shoalwork/currents"
import { Approvals } from "@shoalwork/policy"
import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect } from "vitest"
import { approvalCard, startApprovalNotifier } from "../src/index.js"
import { approvalLayer, scripted } from "./approval-support.js"
import { createBot } from "./support.js"

interface Sent {
  readonly botId: BotId
  readonly text: string
  readonly html: boolean | undefined
  readonly buttons: ReadonlyArray<string>
}

// The part of grammY's InlineKeyboard the test reads (lead does not depend on grammY itself).
interface Markup {
  readonly inline_keyboard: ReadonlyArray<ReadonlyArray<object>>
}

const buttonData = (markup: Markup | undefined): ReadonlyArray<string> =>
  (markup?.inline_keyboard ?? []).flat().flatMap((button) => {
    const data = "callback_data" in button ? button.callback_data : undefined
    return typeof data === "string" ? [data] : []
  })

// A Telegram that records what it is asked to do; `failSend` makes every send fail like an outage.
const fakeTelegram = (failSend = false) => {
  const sent: Array<Sent> = []
  const edits: Array<{ readonly ref: MessageRef; readonly markup: Markup | null }> = []
  const lines: Array<string> = []
  const shape: TelegramOutShape = {
    send: (_botId, text) =>
      Effect.sync(() => {
        lines.push(text)
      }),
    sendRef: (botId, text, opts) =>
      failSend
        ? Effect.fail(new TelegramError({ op: "sendMessage", message: "down" }))
        : Effect.sync(() => {
            sent.push({ botId, text, html: opts?.html, buttons: buttonData(opts?.replyMarkup) })
            return { chatId: "-100", messageId: 55 }
          }),
    editReplyMarkup: (ref, markup) =>
      Effect.sync(() => {
        edits.push({ ref, markup })
      }),
    typing: () => Effect.void,
    ensureTopic: () => Effect.succeed({ chatId: "-100", threadId: 7 }),
    openPodTopic: () => Effect.succeed(1),
    postToPodTopic: () => Effect.void,
  }
  return { shape, sent, edits, lines }
}

// Lets the notifier's fiber and the database answer; no clock involved.
const tick = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))

const until = (done: () => boolean) =>
  Effect.gen(function* () {
    for (let turn = 0; turn < 500 && !done(); turn += 1) {
      yield* tick
    }
  })

const pause = Effect.gen(function* () {
  const bot = yield* createBot
  const sql = yield* SqlClient
  const taskId = newTaskId()
  const now = new Date(0).toISOString()
  yield* sql`INSERT INTO tasks (id, bot_id, spec, state, created_at, updated_at)
    VALUES (${taskId}, ${bot.id}, '{}', 'waiting_approval', ${now}, ${now})`
  const approvals = yield* Approvals
  const request = approvals.request({
    taskId,
    botId: bot.id,
    action: {
      tool: "Bash<b>",
      input: { command: `rm -rf <i>x</i> ${"y".repeat(900)}` },
      resource: "dir/<script>",
    },
    risk: "irreversible",
  })
  return { bot, approvals, request }
})

describe("approval card", () => {
  it.effect("escapes the agent's text, cuts it and shows when the request expires", () =>
    Effect.gen(function* () {
      const { request } = yield* pause
      const card = approvalCard(yield* request)
      expect(card).not.toContain("<script>")
      expect(card).not.toContain("<i>")
      expect(card).toContain("Bash&lt;b&gt;")
      expect(card).toContain("dir/&lt;script&gt;")
      expect(card.length).toBeLessThan(900)
      expect(card).toContain("Expira às 02:00 UTC")
    }).pipe(Effect.provide(approvalLayer(scripted([[]], [])))),
  )
})

describe("approval notifier", () => {
  it.effect(
    "posts the card with Aprovar/Negar, remembers where it is and clears the buttons on a decision",
    () => {
      const telegram = fakeTelegram()
      return Effect.gen(function* () {
        const beacon = yield* Beacon
        const bots = yield* BotRegistry
        const { approvals, request } = yield* pause
        yield* startApprovalNotifier({ beacon, approvals, bots, telegram: telegram.shape })
        const approval = yield* request
        yield* until(() => telegram.sent.length > 0)
        expect(telegram.sent).toHaveLength(1)
        expect(telegram.sent[0]).toMatchObject({
          botId: approval.botId,
          html: true,
          buttons: [`apr:ok:${approval.id}`, `apr:no:${approval.id}`],
        })
        let stored = yield* approvals.get(approval.id)
        for (let turn = 0; turn < 500 && stored.messageId === undefined; turn += 1) {
          yield* tick
          stored = yield* approvals.get(approval.id)
        }
        expect(stored).toMatchObject({ chatId: "-100", threadId: 7, messageId: 55 })
        yield* approvals.resolve(approval.id, "approved", "user:cli")
        yield* until(() => telegram.edits.length > 0 && telegram.lines.length > 0)
        expect(telegram.edits).toEqual([{ ref: { chatId: "-100", messageId: 55 }, markup: null }])
        expect(telegram.lines[0]).toContain("Aprovado por user:cli")
      }).pipe(Effect.scoped, Effect.provide(approvalLayer(scripted([[]], []))))
    },
  )

  it.effect("a Telegram outage leaves the approval pending and decidable", () => {
    const telegram = fakeTelegram(true)
    return Effect.gen(function* () {
      const beacon = yield* Beacon
      const bots = yield* BotRegistry
      const { approvals, request } = yield* pause
      yield* startApprovalNotifier({ beacon, approvals, bots, telegram: telegram.shape })
      const approval = yield* request
      yield* until(() => false)
      expect(telegram.sent).toHaveLength(0)
      expect((yield* approvals.get(approval.id)).status).toBe("pending")
      const decided = yield* approvals.resolve(approval.id, "denied", "user:web")
      expect(decided._tag).toBe("Resolved")
    }).pipe(Effect.scoped, Effect.provide(approvalLayer(scripted([[]], []))))
  })
})
