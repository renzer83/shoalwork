import { type PodDetail, pauseBot, stopPod } from "@shoalwork/api-client"
import { Effect } from "effect"
import { useState } from "react"
import { ScrollView, View } from "react-native"
import { ActivityIndicator, Button, Text, useTheme } from "react-native-paper"
import { useApi } from "../api-context.js"
import { AppBar } from "../components/AppBar.js"
import { MessageBubble } from "../components/chat/MessageBubble.js"
import { DagView } from "../components/dag/DagView.js"
import { ErrorBanner } from "../components/ErrorBanner.js"
import { usePod } from "../hooks/usePod.js"
import { useLocale } from "../i18n/index.js"
import { clock, money } from "./pod-format.js"

export interface PodScreenProps {
  readonly id: string
}

// Runs one action and reports a failure as text; the Pod is refetched afterwards either way.
const runAction = (effect: Effect.Effect<unknown, unknown>, failedText: string) =>
  Effect.runPromise(Effect.result(effect)).then((result) =>
    result._tag === "Success" ? undefined : failedText,
  )

// One Pod: the plan as a graph, the Pod's messages, and the stop and pause actions. Editing the plan is out of scope.
export function PodScreen({ id }: PodScreenProps) {
  const theme = useTheme()
  const { t } = useLocale()
  const { client } = useApi()
  const { load, reload } = usePod(id)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const act = (effect: Effect.Effect<unknown, unknown>) => {
    setBusy(true)
    void runAction(effect, t("pod.actionFailed")).then((error) => {
      setBusy(false)
      setActionError(error)
      reload()
    })
  }

  const detail: PodDetail | undefined = load.kind === "loaded" ? load.detail : undefined
  const titleOf = (stepId: string | null): string =>
    detail?.steps.find((step) => step.id === stepId)?.title ?? t("pod.plan")
  const bots = detail === undefined ? [] : [...new Set(detail.steps.flatMap((step) => step.botId ?? []))]

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <AppBar title={detail?.pod.name ?? t("pod.fallbackTitle")} onRefresh={reload} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
        {load.kind === "loading" ? <ActivityIndicator accessibilityLabel={t("common.loading")} /> : null}
        {load.kind === "failed" ? (
          <ErrorBanner message={t("pod.loadFailed", { status: load.status })} onRetry={reload} />
        ) : null}
        {actionError === undefined ? null : <ErrorBanner message={actionError} />}
        {detail === undefined ? null : (
          <>
            <Text variant="bodyMedium">
              {t("pod.summary", {
                state: detail.pod.state,
                done: detail.steps.filter((step) => step.state === "done").length,
                total: detail.steps.length,
                money: money(detail.steps.reduce((sum, step) => sum + step.usage.usd, 0)),
              })}
            </Text>
            <DagView
              steps={detail.steps.map((step) => ({
                id: step.id,
                title: step.title,
                state: step.state,
                costUsd: step.usage.usd,
                dependsOn: step.dependsOn,
              }))}
            />
            <View style={{ gap: 8 }}>
              <Text variant="titleSmall">{t("pod.messages")}</Text>
              {detail.messages.length === 0 ? <Text variant="bodySmall">{t("pod.noMessages")}</Text> : null}
              {detail.messages.map((message) => (
                <MessageBubble
                  key={message.position}
                  direction="out"
                  text={message.text}
                  time={clock(message.occurredAt)}
                  channel={`${message.kind} · ${titleOf(message.stepId)}`}
                />
              ))}
            </View>
            <View style={{ gap: 8 }}>
              <Button
                mode="outlined"
                disabled={busy || detail.pod.state !== "open"}
                onPress={() => act(stopPod(client, detail.pod.taskId))}
              >
                {t("pod.stop")}
              </Button>
              {bots.map((botId) => (
                <Button key={botId} mode="text" disabled={busy} onPress={() => act(pauseBot(client, botId))}>
                  {t("pod.pauseBot", { bot: botId })}
                </Button>
              ))}
            </View>
          </>
        )}
      </ScrollView>
    </View>
  )
}
