import type { TimelineItem } from "@shoalwork/contracts"
import { DateTime } from "effect"
import { useEffect, useState } from "react"
import { View } from "react-native"
import { Button, Card, Text, useTheme } from "react-native-paper"
import { useApprovals } from "../../hooks/useApprovals.js"

type ApprovalItem = Extract<TimelineItem, { readonly kind: "approval" }>

export interface ApprovalCardProps {
  readonly item: ApprovalItem
  // Called when this app got the decision accepted, so the timeline can update before the live event arrives.
  readonly onDecided?: (status: "approved" | "denied" | "expired", by: string | undefined) => void
  // Test seam: the clock for the countdown.
  readonly now?: () => number
}

// "4:32" until the approval expires; null once it has.
export const remaining = (expiresAtMs: number, nowMs: number): string | null => {
  const seconds = Math.ceil((expiresAtMs - nowMs) / 1000)
  if (seconds <= 0) return null
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`
}

const STATUS_TEXT: Record<ApprovalItem["status"], string> = {
  pending: "Waiting for your decision",
  approved: "Approved",
  denied: "Denied",
  expired: "Expired",
}

export function ApprovalCard({ item, onDecided, now = Date.now }: ApprovalCardProps) {
  const theme = useTheme()
  const { action, resolve } = useApprovals(item.approvalId, onDecided)
  const [tick, setTick] = useState(now())
  const status = action.kind === "done" && action.status !== "pending" ? action.status : item.status
  const open = status === "pending"

  useEffect(() => {
    if (!open) return
    const timer = setInterval(() => setTick(now()), 1000)
    return () => clearInterval(timer)
  }, [open, now])

  const left = open ? remaining(DateTime.toEpochMillis(item.expiresAt), tick) : null
  const busy = action.kind === "sending" || action.kind === "done"
  const locked = !open || busy || (open && left === null)
  const by = action.kind === "done" ? action.by : item.resolvedBy

  return (
    <Card mode="outlined" accessibilityLabel={`Approval request for ${item.tool}`}>
      <Card.Content style={{ gap: 6 }}>
        <Text variant="titleMedium">{`${item.tool} wants to run`}</Text>
        {item.resource === undefined ? null : <Text selectable>{item.resource}</Text>}
        {item.input === undefined ? null : (
          <Text selectable style={{ fontFamily: "monospace", fontSize: 14 }}>
            {item.input}
          </Text>
        )}
        <Text
          style={{
            fontSize: 14,
            color: item.risk === "irreversible" ? theme.colors.error : theme.colors.secondary,
          }}
        >
          {`Risk: ${item.risk}`}
        </Text>
        <Text style={{ fontSize: 14 }}>
          {open
            ? left === null
              ? "Expired"
              : `${STATUS_TEXT.pending} · expires in ${left}`
            : `${STATUS_TEXT[status]}${by === undefined ? "" : ` by ${by}`}`}
        </Text>
        {action.kind === "failed" ? (
          <Text accessibilityRole="alert" style={{ fontSize: 14, color: theme.colors.error }}>
            {action.message}
          </Text>
        ) : null}
        {open ? (
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button
              mode="contained"
              accessibilityLabel="Approve"
              disabled={locked}
              loading={action.kind === "sending" && action.decision === "approved"}
              onPress={() => void resolve("approved")}
            >
              Approve
            </Button>
            <Button
              mode="outlined"
              accessibilityLabel="Deny"
              disabled={locked}
              loading={action.kind === "sending" && action.decision === "denied"}
              onPress={() => void resolve("denied")}
            >
              Deny
            </Button>
          </View>
        ) : null}
      </Card.Content>
    </Card>
  )
}
