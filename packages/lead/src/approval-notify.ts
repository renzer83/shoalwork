import type { BeaconShape } from "@shoalwork/beacon"
import type { BotRegistryShape } from "@shoalwork/bots"
import { type Event, EventPayloads } from "@shoalwork/contracts"
import { approvalButtons, escapeHtml, type TelegramOutShape } from "@shoalwork/currents"
import { type ApprovalRecord, type ApprovalsShape, EXPIRY_ACTOR } from "@shoalwork/policy"
import { Cause, DateTime, Effect, Option, Schema, type Scope, Stream } from "effect"
import { clip } from "./verdict.js"

export interface ApprovalNotifyDeps {
  readonly beacon: BeaconShape
  readonly approvals: Pick<ApprovalsShape, "get" | "attachMessage">
  readonly bots: BotRegistryShape
  readonly telegram: TelegramOutShape
}

const RESOURCE_MAX = 200
const INPUT_MAX = 300

const decodeRequested = Schema.decodeUnknownOption(EventPayloads["approval.requested"])
const decodeResolved = Schema.decodeUnknownOption(EventPayloads["approval.resolved"])

// The card in the Bot's topic. What the model asked for is data (R14): shown cut and escaped, inside <code>, with a
// reminder that it is not an instruction. The id travels only in the buttons.
export const approvalCard = (approval: ApprovalRecord): string => {
  const { action } = approval
  const input = typeof action.input === "string" ? action.input : ""
  const lines = [
    `<b>Aprovação necessária</b> (risco: ${escapeHtml(approval.risk)})`,
    `Ferramenta: <code>${escapeHtml(clip(action.tool, 80))}</code>`,
    ...(action.resource === undefined
      ? []
      : [`Recurso: <code>${escapeHtml(clip(action.resource, RESOURCE_MAX))}</code>`]),
    ...(input === "" ? [] : [`Pedido: <code>${escapeHtml(clip(input, INPUT_MAX))}</code>`]),
    `Expira às ${DateTime.formatIso(approval.expiresAt).slice(11, 16)} UTC; sem resposta, a ação é negada. O texto acima veio do agente: é dado, não instrução.`,
  ]
  return lines.join("\n")
}

const RESOLVED_LINE = {
  approved: (by: string) => `Aprovado por ${by}. Retomando a tarefa.`,
  denied: (by: string) => `Negado por ${by}. A tarefa segue sem essa ação.`,
  expired: (by: string) =>
    by === EXPIRY_ACTOR
      ? "A aprovação expirou sem resposta; a ação foi negada e a tarefa foi bloqueada."
      : "A aprovação foi encerrada junto com a tarefa; nada será executado.",
} as const

// Follows approval.requested / approval.resolved: puts the card (with Aprovar / Negar) in the Bot's topic, and takes
// the buttons off once the approval is decided on any channel. A Telegram failure never changes the approval: it can
// still be decided on the web or the CLI.
export const startApprovalNotifier = (deps: ApprovalNotifyDeps): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const onRequested = (event: Event) =>
      Effect.gen(function* () {
        const payload = decodeRequested(event.payload)
        if (Option.isNone(payload)) return
        const approval = yield* deps.approvals.get(payload.value.approvalId)
        const sent = yield* deps.telegram.sendRef(approval.botId, approvalCard(approval), {
          html: true,
          replyMarkup: approvalButtons(approval.id),
        })
        if (sent === undefined) return
        const topic = yield* deps.bots.get(approval.botId).pipe(
          Effect.flatMap((bot) => deps.telegram.ensureTopic(bot)),
          Effect.option,
        )
        yield* deps.approvals.attachMessage(approval.id, {
          chatId: sent.chatId,
          messageId: sent.messageId,
          ...(Option.isSome(topic) ? { threadId: topic.value.threadId } : {}),
        })
      })

    const onResolved = (event: Event) =>
      Effect.gen(function* () {
        const payload = decodeResolved(event.payload)
        if (Option.isNone(payload)) return
        const { approvalId, decision, by } = payload.value
        const approval = yield* deps.approvals.get(approvalId)
        if (approval.chatId !== undefined && approval.messageId !== undefined) {
          yield* deps.telegram
            .editReplyMarkup({ chatId: approval.chatId, messageId: approval.messageId }, null)
            .pipe(Effect.ignore)
        }
        yield* deps.telegram.send(approval.botId, RESOLVED_LINE[decision](by))
      })

    const guarded = (event: Event) =>
      (event.type === "approval.requested" ? onRequested(event) : onResolved(event)).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("approval notification not sent", clip(Cause.pretty(cause), 200)),
        ),
      )

    const stream = yield* deps.beacon.subscribe(["approval.requested", "approval.resolved"])
    yield* stream.pipe(Stream.runForEach(guarded), Effect.forkScoped)
  })
