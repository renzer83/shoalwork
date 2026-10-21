import type { TimelineItem } from "@shoalwork/contracts"
import { DateTime } from "effect"
import { useEffect, useState } from "react"
import { View } from "react-native"
import { Button, Card, Text, useTheme } from "react-native-paper"
import { useApprovals } from "../../hooks/useApprovals.js"
import { type MessageKey, useLocale } from "../../i18n/index.js"

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

const STATUS_KEY: Readonly<Record<ApprovalItem["status"], MessageKey>> = {
  pending: "approval.waiting",
  approved: "approval.approved",
  denied: "approval.denied",
  expired: "approval.expired",
}

export function ApprovalCard({ item, onDecided, now = Date.now }: ApprovalCardProps) {
  const theme = useTheme()
  const { t } = useLocale()
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
    <Card mode="outlined" accessibilityLabel={t("approval.requestLabel", { tool: item.tool })}>
      <Card.Content style={{ gap: 6 }}>
        <Text variant="titleMedium">{t("approval.wants", { tool: item.tool })}</Text>
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
          {t("approval.risk", { risk: item.risk })}
        </Text>
        <Text style={{ fontSize: 14 }}>
          {open
            ? left === null
              ? t("approval.expired")
              : t("approval.expiresIn", { left })
            : by === undefined
              ? t(STATUS_KEY[status])
              : t("approval.by", { status: t(STATUS_KEY[status]), by })}
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
              accessibilityLabel={t("approval.approve")}
              disabled={locked}
              loading={action.kind === "sending" && action.decision === "approved"}
              onPress={() => void resolve("approved")}
            >
              {t("approval.approve")}
            </Button>
            <Button
              mode="outlined"
              accessibilityLabel={t("approval.deny")}
              disabled={locked}
              loading={action.kind === "sending" && action.decision === "denied"}
              onPress={() => void resolve("denied")}
            >
              {t("approval.deny")}
            </Button>
          </View>
        ) : null}
      </Card.Content>
    </Card>
  )
}
