import { Effect } from "effect"
import { type Bot as GrammyBot, InlineKeyboard } from "grammy"
import { chatAllowed, type InboundOptions, recordInbound, senderAllowed } from "./bot.js"

// Bot proposal ids are "prop_<uuid>" (issued by the lead's bot factory). Button data and parser share this format.
export const PROPOSAL_ID = /^prop_[0-9a-f-]{36}$/

// callback_data is "botprop:<ok|no>:<proposal id>" (52 bytes, under Telegram's 64-byte limit).
const CALLBACK_DATA = /^botprop:(ok|no):(prop_[0-9a-f-]{36})$/

// The two buttons under a Bot proposal: Confirmar and Cancelar.
export const botProposalButtons = (proposalId: string): InlineKeyboard =>
  new InlineKeyboard()
    .text("Confirmar", `botprop:ok:${proposalId}`)
    .text("Cancelar", `botprop:no:${proposalId}`)

// Pure translation: the button press becomes the text command the conversation already routes. Other data is ignored.
export const proposalCallbackText = (data: string): string | undefined => {
  const parsed = CALLBACK_DATA.exec(data)
  const decision = parsed?.[1]
  const proposalId = parsed?.[2]
  return decision === undefined || proposalId === undefined
    ? undefined
    : `/confirm-bot ${proposalId} ${decision}`
}

// callback_data of the /forget buttons (lead's commands/memory.ts): "mem:cancel" or "mem:forget:<memory id>".
const MEMORY_DATA = /^mem:(cancel|forget:mem_[0-9a-f-]{36})$/

// One row of inline buttons. Used by replies that offer a choice; the data is the lead's, never read here.
export const memoryButtons = (buttons: ReadonlyArray<{ readonly label: string; readonly data: string }>) =>
  buttons.reduce((keyboard, button) => keyboard.text(button.label, button.data), new InlineKeyboard())

// Pure translation, like proposalCallbackText: the press becomes "/memory <data>" for the conversation to route.
export const memoryCallbackText = (data: string): string | undefined =>
  MEMORY_DATA.test(data) ? `/memory ${data}` : undefined

// Button presses: same allowlist and chat gate as text messages, then one message.inbound. No decision is made here.
export const installCallbacks = (bot: GrammyBot, options: InboundOptions): void => {
  bot.on("callback_query:data", async (ctx) => {
    if (!senderAllowed(ctx, options) || !chatAllowed(ctx, options)) {
      return
    }
    const data = ctx.callbackQuery.data
    const memoryText = memoryCallbackText(data)
    const text = memoryText ?? proposalCallbackText(data)
    const chat = ctx.chat
    const userId = ctx.from?.id
    if (text !== undefined && chat !== undefined && userId !== undefined) {
      await Effect.runPromiseWith(options.context)(
        recordInbound({
          chatId: String(chat.id),
          threadId: ctx.callbackQuery.message?.message_thread_id,
          userId: String(userId),
          text,
        }),
      )
    }
    // A choice is made once: the keyboard goes away from the message that offered it. Cosmetic, so a message that
    // can no longer be edited is not an error.
    if (memoryText !== undefined) {
      await ctx.editMessageReplyMarkup().catch(() => undefined)
    }
    // Stops the button's spinner; a failure here is reported by the bot's error handler.
    await ctx.answerCallbackQuery()
  })
}
