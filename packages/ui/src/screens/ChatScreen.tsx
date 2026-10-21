import { DateTime } from "effect"
import { useEffect, useRef } from "react"
import { ScrollView, type ScrollViewInstance, View } from "react-native"
import { ActivityIndicator, Button, useTheme } from "react-native-paper"
import { AppBar } from "../components/AppBar.js"
import { ApprovalCard } from "../components/chat/ApprovalCard.js"
import { ArtifactCard } from "../components/chat/ArtifactCard.js"
import { Composer } from "../components/chat/Composer.js"
import { EventChip } from "../components/chat/EventChip.js"
import { MessageBubble } from "../components/chat/MessageBubble.js"
import { EmptyState } from "../components/EmptyState.js"
import { ErrorBanner } from "../components/ErrorBanner.js"
import { chipLabel, type TimelineRow, toRows } from "../hooks/timeline-model.js"
import { useBotTimeline } from "../hooks/useBotTimeline.js"
import { useSendMessage } from "../hooks/useSendMessage.js"
import { useLocale } from "../i18n/index.js"

export interface ChatScreenProps {
  // A Bot id or name; the chat of the Lead is "lead".
  readonly bot: string
  readonly onBack?: () => void
}

const timeOf = (millis: number): string => {
  const date = new Date(millis)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

function Row({
  row,
  timeline,
}: {
  readonly row: TimelineRow
  readonly timeline: ReturnType<typeof useBotTimeline>
}) {
  const { t } = useLocale()
  if (row.kind === "chip") {
    return (
      <EventChip
        label={chipLabel(row, t)}
        detail={row.last}
        tone={row.failedCommands > 0 ? "bad" : "neutral"}
      />
    )
  }
  const { item } = row
  switch (item.kind) {
    case "message":
      return (
        <MessageBubble
          direction={item.direction}
          text={item.text}
          channel={item.channel}
          time={timeOf(DateTime.toEpochMillis(item.occurredAt))}
        />
      )
    case "event":
      return (
        <EventChip
          label={
            item.name === "finished"
              ? t("chat.runFinished", { verdict: item.verdict ?? t("common.unknown") })
              : t("chat.taskState", { state: item.state ?? "" }).trim()
          }
          detail={item.text}
          tone={item.name === "finished" ? (item.verdict === "ok" ? "good" : "bad") : "neutral"}
        />
      )
    case "approval":
      return (
        <ApprovalCard
          item={item}
          onDecided={(status, by) => timeline.markApproval(item.approvalId, status, by)}
        />
      )
    case "artifact":
      return <ArtifactCard item={item} />
  }
}

// The conversation with one Bot: messages, task progress, approval cards and artifacts in one timeline.
export function ChatScreen({ bot, onBack }: ChatScreenProps) {
  const theme = useTheme()
  const { t } = useLocale()
  const timeline = useBotTimeline(bot)
  const sender = useSendMessage(bot)
  const scroller = useRef<ScrollViewInstance>(null)
  const rows = toRows(timeline.items)
  const lastKey = rows.at(-1)?.key

  // New rows at the end keep the view at the bottom; older pages prepended at the top do not move it.
  useEffect(() => {
    scroller.current?.scrollToEnd({ animated: false })
  }, [lastKey])

  const send = async (text: string): Promise<boolean> => {
    const accepted = await sender.send(text)
    if (accepted) timeline.refresh()
    return accepted
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <AppBar title={t("chat.title", { bot })} onRefresh={timeline.reload} />
      {onBack === undefined ? null : <Button onPress={onBack}>{t("common.back")}</Button>}
      <ScrollView ref={scroller} contentContainerStyle={{ padding: 12, gap: 10 }}>
        {timeline.status === "loading" ? (
          <ActivityIndicator accessibilityLabel={t("common.loading")} />
        ) : null}
        {timeline.status === "failed" && timeline.error !== undefined ? (
          <ErrorBanner message={timeline.error} onRetry={timeline.reload} />
        ) : null}
        {timeline.hasOlder ? (
          <Button
            accessibilityLabel={t("chat.loadOlderLabel")}
            loading={timeline.loadingOlder}
            onPress={timeline.loadOlder}
          >
            {t("chat.loadOlder")}
          </Button>
        ) : null}
        {timeline.status === "ready" && rows.length === 0 ? (
          <EmptyState title={t("chat.empty")} hint={t("chat.emptyHint")} />
        ) : null}
        {rows.map((row) => (
          <Row key={row.key} row={row} timeline={timeline} />
        ))}
      </ScrollView>
      {timeline.liveError === undefined ? null : (
        <ErrorBanner message={t("chat.liveError", { error: timeline.liveError })} />
      )}
      <Composer sending={sender.sending} error={sender.error} onSend={send} />
    </View>
  )
}
