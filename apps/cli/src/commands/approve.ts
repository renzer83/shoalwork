import { Approval, ApprovalId, type SchemaViolation } from "@shoalwork/contracts"
import { Effect, Schema } from "effect"
import { type Settings, UsageError } from "../args.js"
import { ApiClient, type HttpError } from "../client.js"

// Mirrors POST /approvals/:id (services/core/src/http/routes/approvals.ts).
export const Decided = Schema.Struct({
  result: Schema.Literals(["resolved", "already"]),
  approval: Approval,
})

export type ApproveCommandError = UsageError | HttpError | SchemaViolation

// `approve <id>` / `deny <id>`: the decision is the operator's, made through the same door as Telegram and the web.
export const approvalDecide = (
  settings: Settings,
  decision: "approved" | "denied",
  rawId: string,
): Effect.Effect<{ readonly result: string; readonly status: string }, ApproveCommandError> =>
  Effect.gen(function* () {
    const id = yield* Schema.decodeUnknownEffect(ApprovalId)(rawId).pipe(
      Effect.mapError(() => new UsageError({ message: `not an approval id: ${rawId}` })),
    )
    const body = yield* new ApiClient(settings.url, settings.token).post(
      `/approvals/${id}`,
      { decision, via: "cli" },
      Decided,
    )
    return { result: body.result, status: body.approval.status }
  })
