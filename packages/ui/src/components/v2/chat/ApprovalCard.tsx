import type { TimelineItem } from "@shoalwork/contracts"
import { DateTime } from "effect"
import { useEffect, useState } from "react"
import { Text, View } from "react-native"
import { useApprovals } from "../../../hooks/useApprovals.js"
import { type MessageKey, useLocale } from "../../../i18n/index.js"
import { tokens } from "../../../theme.js"
import { remaining } from "../../chat/ApprovalCard.js"
import { Avatar } from "../Avatar.js"
import { Icon } from "../Icon.js"
import { PrimaryButton } from "../PrimaryButton.js"

type ApprovalItem = Extract<TimelineItem, { readonly kind: "approval" }>

export interface ApprovalCardProps {
  readonly item: ApprovalItem
  // Called when this app got the decision accepted, so the timeline can update before the live event arrives.
  readonly onDecided?: (status: "approved" | "denied" | "expired", by: string | undefined) => void
  // Test seam: the clock for the countdown.
  readonly now?: () => number
}

const STATUS_KEY: Readonly<Record<ApprovalItem["status"], MessageKey>> = {
  pending: "approval.waiting",
  approved: "approval.approved",
  denied: "approval.denied",
  expired: "approval.expired",
}

// The amber card of the reference. "Aprovar" approves; "Revisar" sends the request back (a denial the Bot reads as
// "not as it is": the core has only the two decisions).
export function ApprovalCard({ item, onDecided, now = Date.now }: ApprovalCardProps) {
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
  const locked = !open || busy || left === null
  const by = action.kind === "done" ? action.by : item.resolvedBy
  const detail = [item.resource, item.input].filter((part) => part !== undefined).join(" ")

  return (
    <View
      accessibilityLabel={t("approval.requestLabel", { tool: item.tool })}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        padding: 14,
        borderRadius: tokens.radius.card,
        borderWidth: 1.5,
        borderColor: open ? tokens.color.amber : tokens.color.border,
        backgroundColor: open ? tokens.color.amberSoft : tokens.color.surface,
      }}
    >
      <Avatar id={item.botId} size={40} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: tokens.color.text, fontSize: tokens.font.size, fontWeight: "700" }}>
          {t("conv.approval.title")}
        </Text>
        <Text selectable style={{ color: tokens.color.textSecondary, fontSize: 14 }}>
          {t("approval.wants", { tool: item.tool })}
        </Text>
        {detail === "" ? null : (
          <Text
            selectable
            style={{ color: tokens.color.textSecondary, fontSize: 14, fontFamily: tokens.font.mono }}
          >
            {detail}
          </Text>
        )}
        <Text
          style={{
            color: item.risk === "irreversible" ? tokens.color.red : tokens.color.textSecondary,
            fontSize: 14,
          }}
        >
          {t("approval.risk", { risk: item.risk })}
        </Text>
        <Text style={{ color: tokens.color.textSecondary, fontSize: 14 }}>
          {open
            ? left === null
              ? t("approval.expired")
              : t("approval.expiresIn", { left })
            : by === undefined
              ? t(STATUS_KEY[status])
              : t("approval.by", { status: t(STATUS_KEY[status]), by })}
        </Text>
        {action.kind === "failed" ? (
          <Text accessibilityRole="alert" style={{ color: tokens.color.red, fontSize: 14 }}>
            {action.message}
          </Text>
        ) : null}
      </View>
      {open ? (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <PrimaryButton
            label={t("conv.approval.approve")}
            disabled={locked}
            icon={<Icon name="check" color={tokens.color.text} size={18} />}
            onPress={() => void resolve("approved")}
          />
          <PrimaryButton
            label={t("conv.approval.review")}
            variant="secondary"
            disabled={locked}
            hint={t("conv.approval.reviewHint")}
            icon={<Icon name="undo" color={tokens.color.textSecondary} size={18} />}
            onPress={() => void resolve("denied")}
          />
        </View>
      ) : null}
    </View>
  )
}
