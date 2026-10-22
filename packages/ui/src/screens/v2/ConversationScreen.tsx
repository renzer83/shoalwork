import type { TimelineItem } from "@shoalwork/contracts"
import { DateTime } from "effect"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { ScrollView, type ScrollViewInstance, Text, useWindowDimensions, View } from "react-native"
import { ErrorBanner } from "../../components/ErrorBanner.js"
import { AboutBot } from "../../components/v2/bot-panel/AboutBot.js"
import { BotCard } from "../../components/v2/bot-panel/BotCard.js"
import { RecentFiles } from "../../components/v2/bot-panel/RecentFiles.js"
import { UsefulLinks } from "../../components/v2/bot-panel/UsefulLinks.js"
import { Card } from "../../components/v2/Card.js"
import { ApprovalCard } from "../../components/v2/chat/ApprovalCard.js"
import { ChatHeader } from "../../components/v2/chat/ChatHeader.js"
import { Composer } from "../../components/v2/chat/Composer.js"
import { LinkCard } from "../../components/v2/chat/LinkCard.js"
import { MessageBubble } from "../../components/v2/chat/MessageBubble.js"
import { PrCard, prNumberOf } from "../../components/v2/chat/PrCard.js"
import { chipLabel, toRows } from "../../hooks/timeline-model.js"
import { useBot } from "../../hooks/useBot.js"
import { useBotTimeline } from "../../hooks/useBotTimeline.js"
import { useSendMessage } from "../../hooks/useSendMessage.js"
import { useLocale } from "../../i18n/index.js"
import { botStatus } from "../../shell/bot-status.js"
import { RightPanel } from "../../shell/RightPanel.js"
import { useShell } from "../../shell/shell-context.js"
import { shellMetrics } from "../../shell/shell-metrics.js"
import { tokens } from "../../theme.js"
import {
  describeBot,
  type Entry,
  fallbackOf,
  modelOf,
  recentFiles,
  toEntries,
  usefulLinks,
} from "./conversation-model.js"

export interface ConversationScreenProps {
  // A Bot id or name; the Guide is "lead".
  readonly bot: string
  // Test seam; defaults to the platform's link opener.
  readonly open?: (url: string) => Promise<unknown>
}

const timeOf = (millis: number): string => {
  const date = new Date(millis)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

// A task-state line between messages: small, centred, never a card.
function Progress({
  label,
  detail,
  bad = false,
}: {
  readonly label: string
  readonly detail?: string | undefined
  readonly bad?: boolean
}) {
  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={detail === undefined ? label : `${label}: ${detail}`}
      style={{ alignSelf: "center", maxWidth: "90%", paddingHorizontal: 12, paddingVertical: 4 }}
    >
      <Text
        numberOfLines={2}
        style={{ color: bad ? tokens.color.red : tokens.color.textSecondary, fontSize: 14 }}
      >
        {detail === undefined ? label : `${label} · ${detail}`}
      </Text>
    </View>
  )
}

// A run of commands and file edits as one discreet pill under the avatar column.
function WorkChip({
  label,
  detail,
  bad,
}: {
  readonly label: string
  readonly detail: string
  readonly bad: boolean
}) {
  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={`${label}: ${detail}`}
      style={{
        alignSelf: "flex-start",
        marginLeft: 56,
        maxWidth: "90%",
        paddingHorizontal: 12,
        paddingVertical: 5,
        borderRadius: tokens.radius.chip,
        borderWidth: 1,
        borderColor: bad ? tokens.color.red : tokens.color.border,
        backgroundColor: tokens.color.surface,
      }}
    >
      <Text
        numberOfLines={1}
        style={{ color: bad ? tokens.color.red : tokens.color.textSecondary, fontSize: 13 }}
      >
        {`${label} · ${detail}`}
      </Text>
    </View>
  )
}

// Under the avatar column, like the cards of the reference that hang from a message.
function Indented({ children, boxed = false }: { readonly children: ReactNode; readonly boxed?: boolean }) {
  return (
    <View
      style={[
        { marginLeft: 56 },
        boxed
          ? { padding: 8, borderRadius: tokens.radius.card, backgroundColor: tokens.color.surface }
          : null,
      ]}
    >
      {children}
    </View>
  )
}

type ArtifactItem = Extract<TimelineItem, { readonly kind: "artifact" }>

// The card of one artifact: a PR, a link, or a plain note/file. No branch, state or route is shown because the
// artifact does not carry them.
function ArtifactView({
  item,
  open,
}: {
  readonly item: ArtifactItem
  readonly open: ConversationScreenProps["open"]
}) {
  const { t } = useLocale()
  const openProp = open === undefined ? {} : { open }
  if (item.artifactKind === "pr") {
    return (
      <PrCard url={item.ref} title={item.summary ?? item.ref} number={prNumberOf(item.ref)} {...openProp} />
    )
  }
  if (item.artifactKind === "url") {
    return <LinkCard url={item.ref} title={item.summary} {...openProp} />
  }
  return (
    <Card
      accessibilityLabel={t(item.artifactKind === "file" ? "artifact.file" : "artifact.text")}
      background={tokens.color.background}
      style={{ gap: 4 }}
    >
      {item.summary === undefined ? null : (
        <Text style={{ color: tokens.color.text, fontSize: tokens.font.size }}>{item.summary}</Text>
      )}
      <Text
        selectable
        style={{
          color: tokens.color.textSecondary,
          fontSize: 14,
          fontFamily: item.artifactKind === "file" ? tokens.font.mono : undefined,
        }}
      >
        {item.ref}
      </Text>
    </Card>
  )
}

function EntryView({
  entry,
  botId,
  botName,
  timeline,
  open,
}: {
  readonly entry: Entry
  readonly botId: string
  readonly botName: string
  readonly timeline: ReturnType<typeof useBotTimeline>
  readonly open: ConversationScreenProps["open"]
}) {
  const { t } = useLocale()
  if (entry.kind === "chip") {
    return (
      <WorkChip
        label={chipLabel(entry.chip, t)}
        detail={entry.chip.last}
        bad={entry.chip.failedCommands > 0}
      />
    )
  }
  if (entry.kind === "message") {
    const { item } = entry
    return (
      <MessageBubble
        author={
          item.direction === "out"
            ? { kind: "bot", id: botId, name: botName }
            : { kind: "human", name: t("conv.operator") }
        }
        time={timeOf(DateTime.toEpochMillis(item.occurredAt))}
        text={item.text}
        wide={entry.cards.length > 0}
      >
        {entry.cards.map((card) => (
          <ArtifactView key={`${card.position}:${card.ref}`} item={card} open={open} />
        ))}
      </MessageBubble>
    )
  }
  const { item } = entry
  switch (item.kind) {
    case "event":
      return (
        <Progress
          label={
            item.name === "finished"
              ? t("chat.runFinished", { verdict: item.verdict ?? t("common.unknown") })
              : t("chat.taskState", { state: item.state ?? "" }).trim()
          }
          detail={item.text}
          bad={item.name === "finished" && item.verdict !== "ok"}
        />
      )
    case "approval":
      return (
        <Indented>
          <ApprovalCard
            item={item}
            onDecided={(status, by) => timeline.markApproval(item.approvalId, status, by)}
          />
        </Indented>
      )
    case "artifact":
      // An artifact with no Bot message before it still gets its own box.
      return (
        <Indented boxed>
          <ArtifactView item={item} open={open} />
        </Indented>
      )
    case "message":
      return null
  }
}

// The conversation with one Bot in the v2 design: header with chips, timeline of cards, composer, and the Bot panel.
export function ConversationScreen({ bot, open }: ConversationScreenProps) {
  const { t } = useLocale()
  const { narrow, openList, openSearch } = useShell()
  const { width } = useWindowDimensions()
  const detail = useBot(bot)
  const timeline = useBotTimeline(bot)
  const sender = useSendMessage(bot)
  const scroller = useRef<ScrollViewInstance>(null)
  const [panelOpen, setPanelOpen] = useState(true)
  const entries = toEntries(toRows(timeline.items))
  const lastKey = entries.at(-1)?.key
  const loaded = detail.load.kind === "loaded" ? detail.load.bot : undefined
  const botId = loaded?.id ?? bot
  const botName = loaded?.name ?? bot
  const status = botStatus(loaded?.state, t)
  const panelWidth = shellMetrics(width).panelWidth

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
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: tokens.color.background }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <ChatHeader
          botId={botId}
          name={botName}
          status={status}
          project={loaded?.project}
          executor={loaded?.executors.preferred}
          model={loaded === undefined ? undefined : modelOf(loaded)}
          onSwitch={narrow ? openList : openSearch}
          onBack={narrow ? openList : undefined}
          onTogglePanel={panelWidth > 0 ? () => setPanelOpen((current) => !current) : undefined}
        />
        <ScrollView ref={scroller} style={{ flex: 1 }} contentContainerStyle={{ padding: 18, gap: 16 }}>
          {timeline.status === "loading" ? (
            <Text style={{ color: tokens.color.textSecondary }}>{t("common.loading")}</Text>
          ) : null}
          {detail.load.kind === "failed" ? (
            <ErrorBanner
              message={
                detail.load.status === 404
                  ? t("chat.noBot")
                  : detail.load.status === 0
                    ? t("common.cannotReach")
                    : t("common.httpAnswered", { status: detail.load.status })
              }
              onRetry={detail.reload}
            />
          ) : null}
          {timeline.status === "failed" && timeline.error !== undefined ? (
            <ErrorBanner message={timeline.error} onRetry={timeline.reload} />
          ) : null}
          {timeline.hasOlder ? (
            <Text
              accessibilityRole="button"
              accessibilityLabel={t("chat.loadOlderLabel")}
              onPress={timeline.loadOlder}
              style={{ alignSelf: "center", color: tokens.color.link, fontSize: 14 }}
            >
              {t("chat.loadOlder")}
            </Text>
          ) : null}
          {timeline.status === "ready" && entries.length === 0 ? (
            <View style={{ alignItems: "center", padding: 24, gap: 6 }}>
              <Text style={{ color: tokens.color.text, fontSize: 17, fontWeight: "600" }}>
                {t("chat.empty")}
              </Text>
              <Text style={{ color: tokens.color.textSecondary, fontSize: 15 }}>{t("chat.emptyHint")}</Text>
            </View>
          ) : null}
          {entries.map((entry) => (
            <EntryView
              key={entry.key}
              entry={entry}
              botId={botId}
              botName={botName}
              timeline={timeline}
              open={open}
            />
          ))}
        </ScrollView>
        {timeline.liveError === undefined ? null : (
          <View
            accessibilityRole="alert"
            style={{
              marginHorizontal: 16,
              padding: 10,
              borderRadius: tokens.radius.button,
              backgroundColor: tokens.color.surface,
            }}
          >
            <Text style={{ color: tokens.color.amber, fontSize: 14 }}>
              {t("chat.liveError", { error: timeline.liveError })}
            </Text>
          </View>
        )}
        <Composer botName={botName} sending={sender.sending} error={sender.error} onSend={send} />
      </View>
      {panelWidth > 0 && panelOpen && loaded !== undefined ? (
        <RightPanel width={panelWidth} title={t("conv.panel.title")} onClose={() => setPanelOpen(false)}>
          <BotCard botId={botId} name={botName} status={status} />
          <AboutBot
            description={describeBot(loaded.instructions)}
            project={loaded.project}
            executor={loaded.executors.preferred}
            model={modelOf(loaded)}
            fallback={fallbackOf(loaded)}
          />
          <RecentFiles files={recentFiles(timeline.items)} />
          <UsefulLinks urls={usefulLinks(timeline.items)} {...(open === undefined ? {} : { open })} />
        </RightPanel>
      ) : null}
    </View>
  )
}
