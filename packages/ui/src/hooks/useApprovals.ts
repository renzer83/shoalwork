import { HttpError } from "@shoalwork/api-client"
import { Effect } from "effect"
import { useCallback, useState } from "react"
import { useApi } from "../api-context.js"

export type Decision = "approved" | "denied"

export type ApprovalAction =
  | { readonly kind: "idle" }
  | { readonly kind: "sending"; readonly decision: Decision }
  // The core's answer: `status` is what the approval is now (it can differ from the click when someone else decided first).
  | {
      readonly kind: "done"
      readonly status: "pending" | "approved" | "denied" | "expired"
      readonly by: string | undefined
    }
  | { readonly kind: "failed"; readonly message: string }

export interface ApprovalDecider {
  readonly action: ApprovalAction
  readonly resolve: (decision: Decision) => Promise<void>
}

const describe = (error: unknown): string => {
  if (error instanceof HttpError) {
    return error.status === 0 ? "Cannot reach the core" : `The core answered HTTP ${error.status}`
  }
  return "The core answered with an unexpected body"
}

// Decides one approval through POST /approvals/:id. One click, one request: while it is in flight or after it
// succeeded the action is not idle, which is what the card uses to disable its buttons.
export function useApprovals(
  approvalId: string,
  onDecided?: (status: "approved" | "denied" | "expired", by: string | undefined) => void,
): ApprovalDecider {
  const { client } = useApi()
  const [action, setAction] = useState<ApprovalAction>({ kind: "idle" })

  const resolve = useCallback(
    async (decision: Decision): Promise<void> => {
      if (action.kind === "sending" || action.kind === "done") return
      setAction({ kind: "sending", decision })
      const result = await Effect.runPromise(Effect.result(client.approvals.resolve(approvalId, decision)))
      if (result._tag === "Failure") {
        setAction({ kind: "failed", message: describe(result.failure) })
        return
      }
      const { approval } = result.success
      setAction({ kind: "done", status: approval.status, by: approval.resolvedBy })
      if (approval.status !== "pending") {
        onDecided?.(approval.status, approval.resolvedBy)
      }
    },
    [action.kind, client, approvalId, onDecided],
  )

  return { action, resolve }
}
