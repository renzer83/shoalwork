import { Context, type Effect } from "effect"
import { InlineKeyboard } from "grammy"

// Approval ids are "apr_<uuid>" (policy's Approvals). Button data and parser share this format.
export const APPROVAL_ID = /^apr_[0-9a-f-]{36}$/

// callback_data is "apr:<ok|no>:<approval id>" (47 bytes, under Telegram's 64-byte limit).
const APPROVAL_DATA = /^apr:(ok|no):(apr_[0-9a-f-]{36})$/

export type ApprovalDecisionKind = "approved" | "denied"

// resolved: this press decided it. already: it had been decided (or expired) before. unknown: no such approval.
// failed: the decision could not be stored; nothing changed and the buttons stay.
export type ApprovalAnswer = "resolved" | "already" | "unknown" | "failed"

// Where a button press goes (bound by the composition root to the Lead's approval flow). Never fails.
export interface ApprovalPort {
  readonly decide: (id: string, decision: ApprovalDecisionKind, by: string) => Effect.Effect<ApprovalAnswer>
}

export class ApprovalDecisions extends Context.Service<ApprovalDecisions, ApprovalPort>()(
  "@shoalwork/ApprovalDecisions",
) {}

// The two buttons under an approval card.
export const approvalButtons = (approvalId: string): InlineKeyboard =>
  new InlineKeyboard().text("Aprovar", `apr:ok:${approvalId}`).text("Negar", `apr:no:${approvalId}`)

// Pure parse of the press: anything that is not exactly the fixed format is ignored.
export const parseApprovalCallback = (
  data: string,
): { readonly id: string; readonly decision: ApprovalDecisionKind } | undefined => {
  const parsed = APPROVAL_DATA.exec(data)
  const kind = parsed?.[1]
  const id = parsed?.[2]
  return kind === undefined || id === undefined
    ? undefined
    : { id, decision: kind === "ok" ? "approved" : "denied" }
}

// Shown to Renan as the toast of the press.
export const ANSWER_TEXT: Record<ApprovalAnswer, string> = {
  resolved: "Registrado.",
  already: "Essa aprovação já foi decidida.",
  unknown: "Aprovação não encontrada.",
  failed: "Não consegui registrar. Tente de novo.",
}
